/**
 * Finds out how to talk to an external BCF server from nothing but its base
 * URL, using only what the BCF API 3.0 / OAuth2 specs define:
 *
 *   GET {base}/bcf/versions        -> where the BCF 3.0 API lives
 *   GET {api}/auth                 -> OAuth2 endpoints (BCF 3.0 §2.1)
 *   GET {base}/.well-known/oauth-authorization-server  (RFC 8414, optional)
 *
 * No server-specific endpoint is used, so any BCF 3.0 server works.
 */

export class BcfServerError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message)
    this.name = 'BcfServerError'
  }
}

export interface BcfServerInfo {
  /** Normalised base URL the user entered (no trailing slash). */
  baseUrl: string
  /** BCF 3.0 API root, with a trailing slash (e.g. https://host/bcf/3.0/). */
  apiBaseUrl: string
  authUrl: string
  tokenUrl: string
  /** RFC 7591 dynamic client registration, when the server offers it. */
  registrationUrl: string | null
  /** Token endpoint client authentication methods the server accepts. */
  tokenAuthMethods: string[]
  scopes: string[]
  /** Whether the server advertises PKCE S256. */
  supportsPkce: boolean
}

const REQUEST_TIMEOUT_MS = 20_000

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const stringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

/**
 * Only http(s) is allowed, and not cloud metadata / link-local addresses --
 * the URL comes from a user and the server fetches it.
 */
export const normaliseBaseUrl = (input: string): string => {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    throw new BcfServerError('The server address is not a valid URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new BcfServerError('The server address must start with https:// or http://')
  if (url.username || url.password)
    throw new BcfServerError('The server address must not contain credentials')
  if (/^169\.254\./.test(url.hostname) || url.hostname === 'metadata.google.internal')
    throw new BcfServerError('That server address is not allowed')
  url.hash = ''
  url.search = ''
  return url.toString().replace(/\/+$/, '')
}

export const getJson = async (
  url: string,
  init?: RequestInit,
  fetchFn: typeof fetch = fetch
): Promise<unknown> => {
  let res: Response
  try {
    res = await fetchFn(url, {
      ...init,
      headers: { Accept: 'application/json', ...(init?.headers || {}) },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
  } catch (e) {
    throw new BcfServerError(
      `Could not reach ${url}: ${e instanceof Error ? e.message : String(e)}`
    )
  }
  if (!res.ok) throw new BcfServerError(`${url} answered HTTP ${res.status}`, res.status)
  try {
    return await res.json()
  } catch {
    throw new BcfServerError(`${url} did not return JSON`)
  }
}

const withSlash = (u: string) => (u.endsWith('/') ? u : `${u}/`)

export const discoverBcfServer = async (
  inputUrl: string,
  fetchFn: typeof fetch = fetch
): Promise<BcfServerInfo> => {
  const baseUrl = normaliseBaseUrl(inputUrl)

  const versions = await getJson(`${baseUrl}/bcf/versions`, undefined, fetchFn)
  const list = isRecord(versions) && Array.isArray(versions.versions) ? versions.versions : []
  const bcf3 = list.find(
    (v) => isRecord(v) && v.api_id === 'bcf' && v.version_id === '3.0'
  )
  if (!isRecord(bcf3) || typeof bcf3.api_base_url !== 'string')
    throw new BcfServerError('The server does not offer the BCF API 3.0')
  const apiBaseUrl = withSlash(bcf3.api_base_url)

  const auth = await getJson(`${apiBaseUrl}auth`, undefined, fetchFn)
  if (!isRecord(auth)) throw new BcfServerError('The server returned no auth information')
  const authUrl = auth.oauth2_auth_url
  const tokenUrl = auth.oauth2_token_url
  if (typeof authUrl !== 'string' || typeof tokenUrl !== 'string')
    throw new BcfServerError('The server does not support OAuth2 sign-in')
  const flows = stringArray(auth.supported_oauth2_flows)
  if (flows.length && !flows.includes('authorization_code_grant'))
    throw new BcfServerError('The server does not support the authorization-code flow')

  let registrationUrl =
    typeof auth.oauth2_dynamic_client_reg_url === 'string'
      ? auth.oauth2_dynamic_client_reg_url
      : null
  let tokenAuthMethods: string[] = []
  let scopes: string[] = []
  let supportsPkce = false
  // RFC 8414 metadata is optional: a server without it still works.
  try {
    const meta = await getJson(
      `${baseUrl}/.well-known/oauth-authorization-server`,
      undefined,
      fetchFn
    )
    if (isRecord(meta)) {
      tokenAuthMethods = stringArray(meta.token_endpoint_auth_methods_supported)
      scopes = stringArray(meta.scopes_supported)
      supportsPkce = stringArray(meta.code_challenge_methods_supported).includes('S256')
      if (!registrationUrl && typeof meta.registration_endpoint === 'string')
        registrationUrl = meta.registration_endpoint
    }
  } catch {
    // ignore
  }

  return {
    baseUrl,
    apiBaseUrl,
    authUrl,
    tokenUrl,
    registrationUrl,
    tokenAuthMethods,
    scopes,
    supportsPkce
  }
}
