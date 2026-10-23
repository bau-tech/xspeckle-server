/**
 * Managing connections to external BCF servers.
 *
 *   POST   /api/v1/bcf-sync/projects/:projectId/connections
 *          { modelId, serverUrl, name?, direction?, clientId?, clientSecret?, returnTo? }
 *          (returnTo: the frontend path to come back to after signing in;
 *          default the project's BCF servers settings)
 *          -> { connection, authorizeUrl }  (send the user to authorizeUrl)
 *   GET    /api/v1/bcf-sync/projects/:projectId/connections
 *   GET    /api/v1/bcf-sync/projects/:projectId/models     (for the model picker)
 *   GET    /api/v1/bcf-sync/projects/:projectId/servers
 *          the servers to offer (set up by server admins, then ones used in
 *          the project) and the callback URL to register an OAuth client for
 *   GET    /api/v1/bcf-sync/projects/:projectId/sync-owners
 *          the models whose topics this server syncs itself, so that another
 *          sync of the same BCF project (one run by the BCF server's side)
 *          stays out; readable by anyone who can read the project
 *   GET    /api/v1/bcf-sync/callback          (OAuth redirect target)
 *   GET    /api/v1/bcf-sync/connections/:id/remote-projects
 *   POST   /api/v1/bcf-sync/connections/:id/remote-project
 *          { remoteProjectId, direction? }
 *   POST   /api/v1/bcf-sync/connections/:id/sync?dryRun=true|false[&allowMassDelete=true]
 *          sync now; a dry run (default) reports what would change, writing nothing
 *   POST   /api/v1/bcf-sync/connections/:id/reauthorize { returnTo? } -> { authorizeUrl }
 *          sign in again, keeping the connection
 *   POST   /api/v1/bcf-sync/connections/:id/activate   start scheduled syncing
 *   POST   /api/v1/bcf-sync/connections/:id/disable    stop it
 *   DELETE /api/v1/bcf-sync/connections/:id
 *
 * After picking the remote project a connection is not synced until it is
 * activated, so a dry run can be looked at first.
 * Everything but the callback and sync-owners needs project-owner rights. The callback is a
 * browser redirect from the BCF server, so it is authorized by the one-time
 * `state` issued when the connection was started.
 */
import type { Request, Response, Router } from 'express'
import { Router as createRouter } from 'express'
import { Scopes, ensureError } from '@speckle/shared'
import { db } from '@/db/knex'
import { corsMiddlewareFactory } from '@/modules/core/configs/cors'
import { buildContext } from '@/modules/shared/middleware'
import { throwIfAuthNotOk } from '@/modules/shared/helpers/errorHelper'
import { validateScopes } from '@/modules/shared'
import { BadRequestError, NotFoundError } from '@/modules/shared/errors'
import { resolveStatusCode } from '@/modules/core/rest/defaultErrorHandler'
import { getFrontendOrigin, getServerOrigin } from '@/modules/shared/helpers/envHelper'
import { getProjectDbClient } from '@/modules/multiregion/utils/dbSelector'
import { BcfServerError } from '@/modules/bcfsync/clients/bcf/discovery'
import {
  deleteBcfConnectionFactory,
  getBcfConnectionForTargetFactory,
  getProjectActiveBcfConnectionsFactory,
  getBcfConnectionByStateFactory,
  getBcfConnectionFactory,
  getProjectBcfConnectionsFactory,
  insertBcfConnectionFactory,
  updateBcfConnectionFactory
} from '@/modules/bcfsync/repositories/connections'
import {
  bcfCallbackUrl,
  completeBcfAuthorizationFactory,
  makeBcfClientFactory,
  reauthorizeBcfConnectionFactory,
  safeReturnPath,
  selectBcfRemoteProjectFactory,
  startBcfConnectionFactory,
  toPublicConnection
} from '@/modules/bcfsync/services/connections'
import type { BcfSyncDirection } from '@/modules/bcfsync/domain/types'
import { bcfServerChoices } from '@/modules/bcfsync/services/servers'
import {
  getBcfServerByUrlFactory,
  listBcfServersFactory
} from '@/modules/bcfsync/repositories/servers'
import { decryptSecret } from '@/modules/bcfsync/services/secrets'
import { runBcfSync } from '@/modules/bcfsync/services/runner'

const DIRECTIONS: BcfSyncDirection[] = ['two-way', 'pull', 'push']

const sendError = (req: Request, res: Response, err: unknown) => {
  const error = ensureError(err)
  // A BCF server that is unreachable or answers badly is a gateway problem.
  const status = error instanceof BcfServerError ? 502 : resolveStatusCode(error)
  if (status >= 500 && !(error instanceof BcfServerError))
    req.log.error({ err: error }, 'BCF connection request failed')
  if (!res.headersSent) res.status(status).json({ error: error.message })
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined)

/** The project settings page that manages connections. */
const settingsPath = (projectId: string) => `/projects/${projectId}/settings/bcf-servers`

export const getBcfSyncRouter = (): Router => {
  const router = createRouter()
  const cors = corsMiddlewareFactory()

  const getConnection = getBcfConnectionFactory({ db })
  const updateConnection = updateBcfConnectionFactory({ db })
  const makeClient = makeBcfClientFactory({ getConnection, updateConnection })

  /** Project-owner check; returns the caller's user id. */
  const authorize = async (req: Request, projectId: string) => {
    const ctx = await buildContext({ req })
    throwIfAuthNotOk(await ctx.authPolicies.project.canUpdate({ userId: ctx.userId, projectId }))
    await validateScopes(ctx.scopes, Scopes.Streams.Write)
    if (!ctx.userId) throw new BadRequestError('Sign in to manage BCF connections')
    return ctx.userId
  }

  const loadConnection = async (req: Request) => {
    const connection = await getConnection(req.params.id)
    if (!connection) throw new NotFoundError('Connection not found')
    const userId = await authorize(req, connection.projectId)
    return { connection, userId }
  }

  router.options('/api/v1/bcf-sync/*', cors)

  router.post('/api/v1/bcf-sync/projects/:projectId/connections', cors, async (req, res) => {
    try {
      const { projectId } = req.params
      const userId = await authorize(req, projectId)
      const modelId = str(req.body?.modelId)
      const serverUrl = str(req.body?.serverUrl)
      if (!modelId || !serverUrl)
        throw new BadRequestError('modelId and serverUrl are required')
      const direction = str(req.body?.direction) as BcfSyncDirection | undefined
      if (direction && !DIRECTIONS.includes(direction))
        throw new BadRequestError(`direction must be one of ${DIRECTIONS.join(', ')}`)

      const projectDb = await getProjectDbClient({ projectId })
      const result = await startBcfConnectionFactory({
        insertConnection: insertBcfConnectionFactory({ db }),
        modelExists: async (pid, mid) =>
          !!(await projectDb('branches').where({ id: mid, streamId: pid }).first('id')),
        configuredClient: async (baseUrl) => {
          const s = await getBcfServerByUrlFactory({ db })(baseUrl)
          return s?.clientId
            ? {
                clientId: s.clientId,
                clientSecret: s.clientSecretEnc ? decryptSecret(s.clientSecretEnc) : null
              }
            : undefined
        },
        serverOrigin: getServerOrigin()
      })({
        projectId,
        modelId,
        userId,
        serverUrl,
        name: str(req.body?.name),
        direction,
        clientId: str(req.body?.clientId)?.trim() || undefined,
        clientSecret: str(req.body?.clientSecret) || undefined,
        returnTo: str(req.body?.returnTo)
      })
      res.status(201).json(result)
    } catch (e) {
      sendError(req, res, e)
    }
  })

  router.get('/api/v1/bcf-sync/projects/:projectId/connections', cors, async (req, res) => {
    try {
      await authorize(req, req.params.projectId)
      const rows = await getProjectBcfConnectionsFactory({ db })(req.params.projectId)
      res.json(rows.map(toPublicConnection))
    } catch (e) {
      sendError(req, res, e)
    }
  })

  router.get('/api/v1/bcf-sync/projects/:projectId/models', cors, async (req, res) => {
    try {
      const { projectId } = req.params
      await authorize(req, projectId)
      const projectDb = await getProjectDbClient({ projectId })
      const models = await projectDb('branches')
        .where({ streamId: projectId })
        .orderBy('name', 'asc')
        .select<Array<{ id: string; name: string }>>('id', 'name')
      res.json(models)
    } catch (e) {
      sendError(req, res, e)
    }
  })

  router.get('/api/v1/bcf-sync/projects/:projectId/servers', cors, async (req, res) => {
    try {
      const { projectId } = req.params
      await authorize(req, projectId)
      const used = await getProjectBcfConnectionsFactory({ db })(projectId)
      res.json({
        servers: bcfServerChoices(await listBcfServersFactory({ db })(), used),
        callbackUrl: bcfCallbackUrl(getServerOrigin())
      })
    } catch (e) {
      sendError(req, res, e)
    }
  })

  router.get('/api/v1/bcf-sync/projects/:projectId/sync-owners', cors, async (req, res) => {
    try {
      const { projectId } = req.params
      const ctx = await buildContext({ req })
      throwIfAuthNotOk(await ctx.authPolicies.project.canRead({ userId: ctx.userId, projectId }))
      if (ctx.userId) await validateScopes(ctx.scopes, Scopes.Streams.Read)
      const rows = await getProjectActiveBcfConnectionsFactory({ db })(projectId)
      res.json(
        rows.map((c) => ({
          modelId: c.modelId,
          serverUrl: c.baseUrl,
          remoteProjectId: c.remoteProjectId,
          direction: c.direction
        }))
      )
    } catch (e) {
      sendError(req, res, e)
    }
  })

  router.get('/api/v1/bcf-sync/callback', async (req, res) => {
    const state = str(req.query.state)
    const code = str(req.query.code)
    const front = (path: string, params: Record<string, string>) => {
      // path is a same-site path (safeReturnPath), so the origin stays ours
      const target = new URL(path, getFrontendOrigin())
      for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v)
      return res.redirect(target.toString())
    }
    try {
      if (!state) throw new BadRequestError('Missing state')
      const pending = await getBcfConnectionByStateFactory({ db })(state)
      if (!pending) throw new BadRequestError('Unknown or already used sign-in request')
      const back = safeReturnPath(pending.oauthReturnTo) || settingsPath(pending.projectId)
      if (str(req.query.error) || !code) {
        // A new connection goes; one that was signing in again stays as it was.
        if (!pending.accessTokenEnc) await deleteBcfConnectionFactory({ db })(pending.id)
        else
          await updateConnection(pending.id, {
            oauthState: null,
            oauthVerifier: null,
            oauthStartedAt: null,
            oauthReturnTo: null
          })
        return front(back, {
          bcfSync: 'denied',
          reason: str(req.query.error_description) || str(req.query.error) || 'no code'
        })
      }
      const connection = await completeBcfAuthorizationFactory({
        getConnectionByState: getBcfConnectionByStateFactory({ db }),
        updateConnection,
        serverOrigin: getServerOrigin()
      })({ state, code })
      return front(back, {
        bcfSync: 'authorized',
        connection: connection.id
      })
    } catch (e) {
      sendError(req, res, e)
    }
  })

  router.get('/api/v1/bcf-sync/connections/:id/remote-projects', cors, async (req, res) => {
    try {
      const { connection } = await loadConnection(req)
      const projects = await (await makeClient(connection)).listProjects()
      res.json(projects.map((p) => ({ id: p.project_id, name: p.name })))
    } catch (e) {
      sendError(req, res, e)
    }
  })

  router.post('/api/v1/bcf-sync/connections/:id/remote-project', cors, async (req, res) => {
    try {
      const { connection } = await loadConnection(req)
      const remoteProjectId = str(req.body?.remoteProjectId)
      if (!remoteProjectId) throw new BadRequestError('remoteProjectId is required')
      const direction = str(req.body?.direction) as BcfSyncDirection | undefined
      if (direction && !DIRECTIONS.includes(direction))
        throw new BadRequestError(`direction must be one of ${DIRECTIONS.join(', ')}`)
      const updated = await selectBcfRemoteProjectFactory({
        updateConnection,
        makeClient,
        findConnectionForTarget: getBcfConnectionForTargetFactory({ db }),
        deleteConnection: deleteBcfConnectionFactory({ db })
      })({
        connection,
        remoteProjectId,
        direction
      })
      res.json(toPublicConnection(updated))
    } catch (e) {
      sendError(req, res, e)
    }
  })

  router.post('/api/v1/bcf-sync/connections/:id/sync', cors, async (req, res) => {
    try {
      const { connection } = await loadConnection(req)
      res.json(
        await runBcfSync(connection.id, {
          dryRun: req.query.dryRun !== 'false',
          allowMassDelete: req.query.allowMassDelete === 'true'
        })
      )
    } catch (e) {
      sendError(req, res, e)
    }
  })

  router.post('/api/v1/bcf-sync/connections/:id/reauthorize', cors, async (req, res) => {
    try {
      const { connection } = await loadConnection(req)
      const authorizeUrl = await reauthorizeBcfConnectionFactory({
        updateConnection,
        serverOrigin: getServerOrigin()
      })(connection, str(req.body?.returnTo))
      res.json({ authorizeUrl })
    } catch (e) {
      sendError(req, res, e)
    }
  })

  router.post('/api/v1/bcf-sync/connections/:id/activate', cors, async (req, res) => {
    try {
      const { connection } = await loadConnection(req)
      if (!connection.remoteProjectId)
        throw new BadRequestError('Pick the BCF project to sync with first')
      if (!connection.accessTokenEnc)
        throw new BadRequestError('Sign in at the BCF server first')
      const updated = await updateConnection(connection.id, {
        status: 'active',
        lastError: null
      })
      res.json(toPublicConnection(updated!))
    } catch (e) {
      sendError(req, res, e)
    }
  })

  router.post('/api/v1/bcf-sync/connections/:id/disable', cors, async (req, res) => {
    try {
      const { connection } = await loadConnection(req)
      const updated = await updateConnection(connection.id, { status: 'disabled' })
      res.json(toPublicConnection(updated!))
    } catch (e) {
      sendError(req, res, e)
    }
  })

  router.delete('/api/v1/bcf-sync/connections/:id', cors, async (req, res) => {
    try {
      const { connection } = await loadConnection(req)
      await deleteBcfConnectionFactory({ db })(connection.id)
      res.status(204).end()
    } catch (e) {
      sendError(req, res, e)
    }
  })

  return router
}
