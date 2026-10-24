/**
 * The BCF servers offered when connecting a model, for server admins:
 *
 *   GET    /api/v1/bcf-sync/servers
 *   POST   /api/v1/bcf-sync/servers        { name, url, clientId?, clientSecret? }
 *   PATCH  /api/v1/bcf-sync/servers/:id    same fields; clientSecret omitted = unchanged,
 *                                          '' = removed
 *   DELETE /api/v1/bcf-sync/servers/:id
 *
 * Saving checks that the address is a BCF API 3.0 or 2.1 server. Existing
 * connections are not affected by changes here.
 */
import type { Request, Response, Router } from 'express'
import { Router as createRouter } from 'express'
import { Roles, Scopes, ensureError } from '@speckle/shared'
import { db } from '@/db/knex'
import { corsMiddlewareFactory } from '@/modules/core/configs/cors'
import { buildContext } from '@/modules/shared/middleware'
import { validateScopes } from '@/modules/shared'
import { BadRequestError, ForbiddenError, NotFoundError } from '@/modules/shared/errors'
import { resolveStatusCode } from '@/modules/core/rest/defaultErrorHandler'
import {
  deleteBcfServerFactory,
  getBcfServerByUrlFactory,
  getBcfServerFactory,
  insertBcfServerFactory,
  listBcfServersFactory,
  updateBcfServerFactory
} from '@/modules/bcfsync/repositories/servers'
import {
  toPublicServer,
  validateBcfServerInputFactory,
  type BcfServerInput
} from '@/modules/bcfsync/services/servers'
import { encryptSecret } from '@/modules/bcfsync/services/secrets'

const sendError = (req: Request, res: Response, err: unknown) => {
  const error = ensureError(err)
  const status = resolveStatusCode(error)
  if (status >= 500) req.log.error({ err: error }, 'BCF server admin request failed')
  if (!res.headersSent) res.status(status).json({ error: error.message })
}

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : undefined)

const requireAdmin = async (req: Request) => {
  const ctx = await buildContext({ req })
  if (!ctx.userId || ctx.role !== Roles.Server.Admin)
    throw new ForbiddenError('Only server admins can manage BCF servers')
  await validateScopes(ctx.scopes, Scopes.Server.Setup)
}

export const getBcfServersRouter = (): Router => {
  const router = createRouter()
  const cors = corsMiddlewareFactory()
  const validate = validateBcfServerInputFactory()
  const getByUrl = getBcfServerByUrlFactory({ db })

  router.options('/api/v1/bcf-sync/servers', cors)
  router.options('/api/v1/bcf-sync/servers/:id', cors)

  router.get('/api/v1/bcf-sync/servers', cors, async (req, res) => {
    try {
      await requireAdmin(req)
      res.json((await listBcfServersFactory({ db })()).map(toPublicServer))
    } catch (e) {
      sendError(req, res, e)
    }
  })

  router.post('/api/v1/bcf-sync/servers', cors, async (req, res) => {
    try {
      await requireAdmin(req)
      const body = (req.body || {}) as BcfServerInput
      const name = text(body.name)
      const rawUrl = text(body.url)
      if (!name || !rawUrl) throw new BadRequestError('name and url are required')
      const clientId = text(body.clientId) || null
      const clientSecret = text(body.clientSecret) || null
      const { url } = await validate({ url: rawUrl, clientId })
      if (await getByUrl(url)) throw new BadRequestError('This server is already set up')
      const row = await insertBcfServerFactory({ db })({
        name,
        url,
        clientId,
        clientSecretEnc: clientId && clientSecret ? encryptSecret(clientSecret) : null
      })
      res.status(201).json(toPublicServer(row))
    } catch (e) {
      sendError(req, res, e)
    }
  })

  router.patch('/api/v1/bcf-sync/servers/:id', cors, async (req, res) => {
    try {
      await requireAdmin(req)
      const existing = await getBcfServerFactory({ db })(req.params.id)
      if (!existing) throw new NotFoundError('BCF server not found')
      const body = (req.body || {}) as BcfServerInput
      const name = body.name === undefined ? existing.name : text(body.name)
      if (!name) throw new BadRequestError('name is required')
      const clientId =
        body.clientId === undefined ? existing.clientId : text(body.clientId) || null
      const url =
        body.url === undefined && body.clientId === undefined
          ? existing.url
          : (await validate({ url: text(body.url) || existing.url, clientId })).url
      if (url !== existing.url && (await getByUrl(url)))
        throw new BadRequestError('This server is already set up')
      const clientSecretEnc = !clientId
        ? null
        : body.clientSecret === undefined
        ? existing.clientSecretEnc
        : text(body.clientSecret)
        ? encryptSecret(text(body.clientSecret)!)
        : null
      const row = await updateBcfServerFactory({ db })(existing.id, {
        name,
        url,
        clientId,
        clientSecretEnc
      })
      res.json(toPublicServer(row!))
    } catch (e) {
      sendError(req, res, e)
    }
  })

  router.delete('/api/v1/bcf-sync/servers/:id', cors, async (req, res) => {
    try {
      await requireAdmin(req)
      if (!(await deleteBcfServerFactory({ db })(req.params.id)))
        throw new NotFoundError('BCF server not found')
      res.status(204).end()
    } catch (e) {
      sendError(req, res, e)
    }
  })

  return router
}
