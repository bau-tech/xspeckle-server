import {
  BcfServerError,
  discoverBcfServer
} from '@/modules/bcfsync/clients/bcf/discovery'
import {
  buildAuthorizeUrl,
  exchangeCode,
  generatePkce,
  generateState,
  refreshTokens,
  registerClient,
  type BcfOAuthClient
} from '@/modules/bcfsync/clients/bcf/oauth'
import { BcfClient } from '@/modules/bcfsync/clients/bcf/client'
import type {
  BcfServerConnectionPublic,
  BcfServerConnectionRecord,
  BcfSyncDirection
} from '@/modules/bcfsync/domain/types'
import type {
  getBcfConnectionByStateFactory,
  getBcfConnectionFactory,
  insertBcfConnectionFactory,
  updateBcfConnectionFactory
} from '@/modules/bcfsync/repositories/connections'
import { decryptSecret, encryptSecret } from '@/modules/bcfsync/services/secrets'
import { BadRequestError, NotFoundError } from '@/modules/shared/errors'

/** How long a user has to finish signing in at the BCF server. */
const OAUTH_STATE_TTL_MS = 15 * 60 * 1000
/** Refresh slightly early so a request never carries an about-to-expire token. */
const EXPIRY_SKEW_MS = 60 * 1000

export const bcfCallbackUrl = (serverOrigin: string) =>
  `${serverOrigin.replace(/\/+$/, '')}/api/v1/bcf-sync/callback`

/**
 * A frontend path to return to after signing in, or null: only paths on
 * this site ("/projects/..."), never another origin ("//host", "/\host").
 */
export const safeReturnPath = (value: unknown): string | null => {
  if (typeof value !== 'string' || value.length > 1000) return null
  if (!value.startsWith('/') || value.startsWith('//') || /[\\\s]/.test(value)) return null
  return value
}

export const toPublicConnection = (
  c: BcfServerConnectionRecord
): BcfServerConnectionPublic => {
  const {
    clientSecretEnc: _a,
    accessTokenEnc: _b,
    refreshTokenEnc: _c,
    oauthState: _d,
    oauthVerifier: _e,
    oauthReturnTo: _f,
    server,
    ...rest
  } = c
  return { ...rest, serverUrl: server.baseUrl }
}

export const startBcfConnectionFactory =
  (deps: {
    insertConnection: ReturnType<typeof insertBcfConnectionFactory>
    modelExists: (projectId: string, modelId: string) => Promise<boolean>
    /** The OAuth client an admin set up for that server, if any. */
    configuredClient?: (baseUrl: string) => Promise<BcfOAuthClient | undefined>
    serverOrigin: string
    fetchFn?: typeof fetch
  }) =>
  async (args: {
    projectId: string
    modelId: string
    userId: string
    serverUrl: string
    name?: string
    direction?: BcfSyncDirection
    /** For servers without automatic client registration. */
    clientId?: string
    clientSecret?: string
    /** Frontend path to come back to after signing in. */
    returnTo?: string
  }) => {
    if (!(await deps.modelExists(args.projectId, args.modelId)))
      throw new NotFoundError('Model not found in this project')

    const info = await discoverBcfServer(args.serverUrl, deps.fetchFn)
    const redirectUri = bcfCallbackUrl(deps.serverOrigin)
    // A client given here, else the admin's for this server, else register one.
    const client: BcfOAuthClient = args.clientId
      ? { clientId: args.clientId, clientSecret: args.clientSecret || null }
      : (await deps.configuredClient?.(info.baseUrl)) ||
        (await registerClient({
          info,
          redirectUri,
          clientName: 'xSpeckle',
          fetchFn: deps.fetchFn
        }))
    const { verifier, challenge } = generatePkce()
    const state = generateState()

    const connection = await deps.insertConnection({
      projectId: args.projectId,
      modelId: args.modelId,
      createdBy: args.userId,
      name: args.name?.trim() || new URL(info.baseUrl).host,
      baseUrl: info.baseUrl,
      server: info,
      clientId: client.clientId,
      clientSecretEnc: client.clientSecret ? encryptSecret(client.clientSecret) : null,
      oauthState: state,
      oauthVerifier: verifier,
      oauthStartedAt: new Date(),
      oauthReturnTo: safeReturnPath(args.returnTo),
      direction: args.direction || 'two-way'
    })

    return {
      connection: toPublicConnection(connection),
      authorizeUrl: buildAuthorizeUrl({
        info,
        clientId: client.clientId,
        redirectUri,
        state,
        codeChallenge: challenge
      })
    }
  }

const clientOf = (c: BcfServerConnectionRecord): BcfOAuthClient => ({
  clientId: c.clientId,
  clientSecret: c.clientSecretEnc ? decryptSecret(c.clientSecretEnc) : null
})

export const completeBcfAuthorizationFactory =
  (deps: {
    getConnectionByState: ReturnType<typeof getBcfConnectionByStateFactory>
    updateConnection: ReturnType<typeof updateBcfConnectionFactory>
    serverOrigin: string
    fetchFn?: typeof fetch
  }) =>
  async (args: { state: string; code: string }) => {
    const connection = await deps.getConnectionByState(args.state)
    if (!connection || !connection.oauthVerifier)
      throw new BadRequestError('Unknown or already used sign-in request')
    if (
      !connection.oauthStartedAt ||
      Date.now() - connection.oauthStartedAt.getTime() > OAUTH_STATE_TTL_MS
    )
      throw new BadRequestError('The sign-in request expired; connect again')

    const tokens = await exchangeCode({
      info: connection.server,
      client: clientOf(connection),
      code: args.code,
      codeVerifier: connection.oauthVerifier,
      redirectUri: bcfCallbackUrl(deps.serverOrigin),
      fetchFn: deps.fetchFn
    })
    const updated = await deps.updateConnection(connection.id, {
      accessTokenEnc: encryptSecret(tokens.accessToken),
      refreshTokenEnc: tokens.refreshToken ? encryptSecret(tokens.refreshToken) : null,
      accessTokenExpiresAt: tokens.expiresAt,
      // single use
      oauthState: null,
      oauthVerifier: null,
      oauthStartedAt: null,
      oauthReturnTo: null,
      // A connection that already syncs a project (signing in again) resumes.
      status: connection.remoteProjectId ? 'active' : 'authorized',
      lastError: null
    })
    return updated!
  }

/**
 * Signs in again for an existing connection (expired or revoked sign-in),
 * with the same OAuth client: its project choice and sync history stay.
 */
export const reauthorizeBcfConnectionFactory =
  (deps: {
    updateConnection: ReturnType<typeof updateBcfConnectionFactory>
    serverOrigin: string
  }) =>
  async (connection: BcfServerConnectionRecord, returnTo?: string) => {
    const { verifier, challenge } = generatePkce()
    const state = generateState()
    await deps.updateConnection(connection.id, {
      oauthState: state,
      oauthVerifier: verifier,
      oauthStartedAt: new Date(),
      oauthReturnTo: safeReturnPath(returnTo)
    })
    return buildAuthorizeUrl({
      info: connection.server,
      clientId: connection.clientId,
      redirectUri: bcfCallbackUrl(deps.serverOrigin),
      state,
      codeChallenge: challenge
    })
  }

/**
 * A BcfClient for a connection. Refreshes the token when it is (nearly)
 * expired or the server answered 401; concurrent callers share one refresh,
 * which matters because servers rotate refresh tokens.
 */
export const makeBcfClientFactory = (deps: {
  getConnection: ReturnType<typeof getBcfConnectionFactory>
  updateConnection: ReturnType<typeof updateBcfConnectionFactory>
  fetchFn?: typeof fetch
}) => {
  const inflight = new Map<string, Promise<string>>()

  const accessToken = async (connectionId: string, force: boolean) => {
    const existing = inflight.get(connectionId)
    if (existing) return await existing
    const run = (async () => {
      const c = await deps.getConnection(connectionId)
      if (!c) throw new NotFoundError('Connection not found')
      if (!c.accessTokenEnc) throw new BcfServerError('Connection is not authorized')
      const fresh =
        !force &&
        (!c.accessTokenExpiresAt ||
          c.accessTokenExpiresAt.getTime() - Date.now() > EXPIRY_SKEW_MS)
      if (fresh) return decryptSecret(c.accessTokenEnc)
      if (!c.refreshTokenEnc) {
        await deps.updateConnection(c.id, {
          status: 'error',
          lastError: 'Sign-in expired; reconnect to the BCF server'
        })
        throw new BcfServerError('Sign-in expired and there is no refresh token', 401)
      }
      try {
        const t = await refreshTokens({
          info: c.server,
          client: clientOf(c),
          refreshToken: decryptSecret(c.refreshTokenEnc),
          fetchFn: deps.fetchFn
        })
        await deps.updateConnection(c.id, {
          accessTokenEnc: encryptSecret(t.accessToken),
          refreshTokenEnc: t.refreshToken ? encryptSecret(t.refreshToken) : null,
          accessTokenExpiresAt: t.expiresAt
        })
        return t.accessToken
      } catch (e) {
        await deps.updateConnection(c.id, {
          status: 'error',
          lastError: 'Sign-in expired; reconnect to the BCF server'
        })
        throw e
      }
    })().finally(() => inflight.delete(connectionId))
    inflight.set(connectionId, run)
    return await run
  }

  return async (connection: BcfServerConnectionRecord) =>
    new BcfClient({
      apiBaseUrl: connection.server.apiBaseUrl,
      getAccessToken: (force) => accessToken(connection.id, force),
      fetchFn: deps.fetchFn
    })
}

export const selectBcfRemoteProjectFactory =
  (deps: {
    updateConnection: ReturnType<typeof updateBcfConnectionFactory>
    makeClient: ReturnType<typeof makeBcfClientFactory>
  }) =>
  async (args: {
    connection: BcfServerConnectionRecord
    remoteProjectId: string
    direction?: BcfSyncDirection
  }) => {
    if (args.connection.status === 'pending')
      throw new BadRequestError('Finish signing in at the BCF server first')
    const client = await deps.makeClient(args.connection)
    let project
    try {
      project = await client.getProject(args.remoteProjectId)
    } catch (e) {
      if (e instanceof BcfServerError && (e.status === 404 || e.status === 403))
        throw new BadRequestError('That BCF project does not exist or is not accessible')
      throw e
    }
    return (await deps.updateConnection(args.connection.id, {
      remoteProjectId: args.remoteProjectId,
      remoteProjectName: project.name,
      direction: args.direction || args.connection.direction,
      // Not syncing yet: the user looks at a dry run, then activates.
      status: args.connection.status === 'active' ? 'active' : 'authorized',
      lastError: null
    }))!
  }
