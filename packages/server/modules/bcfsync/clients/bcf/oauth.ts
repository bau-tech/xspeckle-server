/* eslint-disable camelcase */
import crypto from 'node:crypto'
import { BcfServerError, type BcfServerInfo } from '@/modules/bcfsync/clients/bcf/discovery'

export interface BcfOAuthClient {
  clientId: string
  clientSecret: string | null
}

export interface BcfTokens {
  accessToken: string
  refreshToken: string | null
  /** Absolute expiry; null when the server did not say. */
  expiresAt: Date | null
}

const WANTED_SCOPES = ['openid', 'offline_access', 'bcf']

export const generatePkce = () => {
  const verifier = crypto.randomBytes(32).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

export const generateState = () => crypto.randomBytes(24).toString('base64url')

/** Only the scopes the server supports; none when it does not publish a list. */
const pickScopes = (info: BcfServerInfo) =>
  info.scopes.length ? WANTED_SCOPES.filter((s) => info.scopes.includes(s)) : []

/** RFC 7591 dynamic client registration. */
export const registerClient = async (args: {
  info: BcfServerInfo
  redirectUri: string
  clientName: string
  fetchFn?: typeof fetch
}): Promise<BcfOAuthClient> => {
  const { info, redirectUri, clientName, fetchFn = fetch } = args
  if (!info.registrationUrl)
    throw new BcfServerError(
      'The server does not support automatic client registration; enter a client id and secret'
    )
  const method = info.tokenAuthMethods.length
    ? ['client_secret_basic', 'client_secret_post'].find((m) =>
        info.tokenAuthMethods.includes(m)
      ) || info.tokenAuthMethods[0]
    : 'client_secret_basic'
  const res = await fetchFn(info.registrationUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: method
    }),
    signal: AbortSignal.timeout(20_000)
  })
  if (!res.ok)
    throw new BcfServerError(`Client registration failed (HTTP ${res.status})`, res.status)
  const body: unknown = await res.json()
  const b = body as Record<string, unknown>
  if (!b || typeof b.client_id !== 'string')
    throw new BcfServerError('Client registration returned no client_id')
  return {
    clientId: b.client_id,
    clientSecret: typeof b.client_secret === 'string' ? b.client_secret : null
  }
}

export const buildAuthorizeUrl = (args: {
  info: BcfServerInfo
  clientId: string
  redirectUri: string
  state: string
  codeChallenge: string
}) => {
  const url = new URL(args.info.authUrl)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', args.clientId)
  url.searchParams.set('redirect_uri', args.redirectUri)
  url.searchParams.set('state', args.state)
  url.searchParams.set('code_challenge', args.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  const scopes = pickScopes(args.info)
  if (scopes.length) url.searchParams.set('scope', scopes.join(' '))
  return url.toString()
}

const tokenRequest = async (
  info: BcfServerInfo,
  client: BcfOAuthClient,
  params: Record<string, string>,
  fetchFn: typeof fetch
): Promise<BcfTokens> => {
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json'
  }
  const body = new URLSearchParams(params)
  const useBasic =
    !!client.clientSecret &&
    (!info.tokenAuthMethods.length || info.tokenAuthMethods.includes('client_secret_basic'))
  if (useBasic) {
    headers.Authorization = `Basic ${Buffer.from(
      `${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret!)}`
    ).toString('base64')}`
  } else {
    body.set('client_id', client.clientId)
    if (client.clientSecret) body.set('client_secret', client.clientSecret)
  }
  const res = await fetchFn(info.tokenUrl, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(20_000)
  })
  const text = await res.text()
  let json: Record<string, unknown> = {}
  try {
    json = JSON.parse(text)
  } catch {
    // handled below
  }
  if (!res.ok) {
    const detail = typeof json.error === 'string' ? json.error : `HTTP ${res.status}`
    throw new BcfServerError(`Token request failed: ${detail}`, res.status)
  }
  if (typeof json.access_token !== 'string')
    throw new BcfServerError('Token response has no access_token')
  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : null,
    expiresAt:
      typeof json.expires_in === 'number'
        ? new Date(Date.now() + json.expires_in * 1000)
        : null
  }
}

export const exchangeCode = (args: {
  info: BcfServerInfo
  client: BcfOAuthClient
  code: string
  codeVerifier: string
  redirectUri: string
  fetchFn?: typeof fetch
}) =>
  tokenRequest(
    args.info,
    args.client,
    {
      grant_type: 'authorization_code',
      code: args.code,
      code_verifier: args.codeVerifier,
      redirect_uri: args.redirectUri
    },
    args.fetchFn || fetch
  )

export const refreshTokens = async (args: {
  info: BcfServerInfo
  client: BcfOAuthClient
  refreshToken: string
  fetchFn?: typeof fetch
}) => {
  const tokens = await tokenRequest(
    args.info,
    args.client,
    { grant_type: 'refresh_token', refresh_token: args.refreshToken },
    args.fetchFn || fetch
  )
  // A server may keep the same refresh token and not repeat it.
  return { ...tokens, refreshToken: tokens.refreshToken ?? args.refreshToken }
}
