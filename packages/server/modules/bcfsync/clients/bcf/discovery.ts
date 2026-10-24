/**
 * Finds out how to talk to an external BCF server from nothing but its base
 * URL, using only what the BCF API / OAuth2 specs define:
 *
 *   GET {base}/bcf/versions        -> which BCF API versions it offers, and where
 *   GET {api}/auth                 -> OAuth2 endpoints
 *   GET {base}/.well-known/oauth-authorization-server  (RFC 8414, optional)
 *   GET {issuer}/.well-known/openid-configuration      (OpenID discovery, optional)
 *
 * BCF 3.0 is used when offered, else BCF 2.1; both share the endpoints and
 * wire shapes the sync uses. No server-specific endpoint is used.
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

export type BcfApiVersion = '3.0' | '2.1'

export interface BcfServerInfo {
  /** Normalised base URL the user entered (no trailing slash). */
  baseUrl: string
  /** BCF API root, with a trailing slash (e.g. https://host/bcf/3.0/). */
  apiBaseUrl: string
  /** Missing on connections saved before BCF 2.1 support, which are all 3.0. */
  apiVersion?: BcfApiVersion
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

const SUPPORTED_VERSIONS: BcfApiVersion[] = ['3.0', '2.1']

/**
 * The newest BCF API version the server offers. `api_id` and `api_base_url`
 * are BCF 3.0 additions: a 2.1 server lists bare `version_id`s, and its API
 * lives at {base}/bcf/{version}/.
 */
const pickVersion = (baseUrl: string, versions: unknown) => {
  const list = isRecord(versions) && Array.isArray(versions.versions) ? versions.versions : []
  for (const version of SUPPORTED_VERSIONS) {
    const entry = list.find(
      (v) =>
        isRecord(v) &&
        v.version_id === version &&
        (v.api_id === undefined || v.api_id === 'bcf')
    )
    if (!isRecord(entry)) continue
    const apiBaseUrl =
      typeof entry.api_base_url === 'string' && entry.api_base_url
        ? entry.api_base_url
        : `${baseUrl}/bcf/${version}`
    return { version, apiBaseUrl: withSlash(apiBaseUrl) }
  }
  throw new BcfServerError('The server offers neither the BCF API 3.0 nor 2.1')
}

/**
 * Where the authorization server may publish its metadata: RFC 8414 at the
 * base URL, else OpenID discovery at the authorize endpoint's parent paths
 * (e.g. an identity server at {host}/identity).
 */
const metadataUrls = (baseUrl: string, authUrl: string) => {
  const urls = [`${baseUrl}/.well-known/oauth-authorization-server`]
  try {
    const u = new URL(authUrl)
    const parts = u.pathname.split('/').filter(Boolean).slice(0, -1)
    for (let i = parts.length; i >= 0; i--) {
      const issuer = `${u.origin}${parts
        .slice(0, i)
        .map((p) => `/${p}`)
        .join('')}`
      urls.push(`${issuer}/.well-known/openid-configuration`)
    }
  } catch {
    // no OpenID candidates
  }
  return [...new Set(urls)]
}

export const discoverBcfServer = async (
  inputUrl: string,
  fetchFn: typeof fetch = fetch
): Promise<BcfServerInfo> => {
  const baseUrl = normaliseBaseUrl(inputUrl)

  const versions = await getJson(`${baseUrl}/bcf/versions`, undefined, fetchFn)
  const { version: apiVersion, apiBaseUrl } = pickVersion(baseUrl, versions)

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
  // Metadata is optional: a server without it still works. The first document
  // found wins; one guessed from the authorize endpoint's path only when it
  // is for that endpoint.
  const [rfc8414Url, ...openIdUrls] = metadataUrls(baseUrl, authUrl)
  for (const url of [rfc8414Url, ...openIdUrls]) {
    let meta: unknown
    try {
      meta = await getJson(url, undefined, fetchFn)
    } catch {
      continue
    }
    if (!isRecord(meta)) continue
    if (url !== rfc8414Url && meta.authorization_endpoint !== authUrl) continue
    tokenAuthMethods = stringArray(meta.token_endpoint_auth_methods_supported)
    scopes = stringArray(meta.scopes_supported)
    supportsPkce = stringArray(meta.code_challenge_methods_supported).includes('S256')
    if (!registrationUrl && typeof meta.registration_endpoint === 'string')
      registrationUrl = meta.registration_endpoint
    break
  }

  return {
    baseUrl,
    apiBaseUrl,
    apiVersion,
    authUrl,
    tokenUrl,
    registrationUrl,
    tokenAuthMethods,
    scopes,
    supportsPkce
  }
}
