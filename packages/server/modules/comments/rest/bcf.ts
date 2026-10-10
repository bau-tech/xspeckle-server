/**
 * BCF archive transfer:
 *
 *   GET  /api/projects/:projectId/bcf/export
 *        ?resourceIdString=<viewer resources>  topics of these models (all when omitted)
 *        &loadedVersionsOnly=true              only topics of the referenced versions
 *        &topicIds=a,b                         only these topics
 *        &version=2.1|3.0                      default 2.1 (.bcfzip); 3.0 gives .bcf
 *
 *   POST /api/projects/:projectId/bcf/import?resourceIdString=<viewer resources>
 *        multipart/form-data with one .bcf/.bcfzip file; new topics are attached
 *        to the given resources. Responds with a JSON import report.
 */
import type { Request, Response, Router } from 'express'
import { Router as createRouter } from 'express'
import Busboy from 'busboy'
import { corsMiddlewareFactory } from '@/modules/core/configs/cors'
import { buildContext } from '@/modules/shared/middleware'
import { throwIfAuthNotOk } from '@/modules/shared/helpers/errorHelper'
import { validateScopes } from '@/modules/shared'
import { Scopes } from '@speckle/shared'
import { getProjectDbClient } from '@/modules/multiregion/utils/dbSelector'
import { getEventBus } from '@/modules/shared/services/eventBus'
import { getBlobsFactory } from '@/modules/blobstorage/repositories'
import { validateInputAttachmentsFactory } from '@/modules/comments/services/commentTextService'
import {
  createCommentReplyAndNotifyFactory,
  createCommentThreadAndNotifyFactory,
  createViewpointFactory,
  editTopicAndNotifyFactory
} from '@/modules/comments/services/management'
import {
  bcfTopicRepositoriesFactory,
  deleteCommentDocumentReferencesFactory,
  deleteCommentRelatedTopicsFactory,
  getCommentDocumentReferencesFactory,
  getCommentFactory,
  getCommentRelatedTopicsFactory,
  getCommentsResourcesFactory,
  getPaginatedProjectCommentsPageFactory,
  getTopicViewpointsFactory,
  insertCommentLinksFactory,
  insertCommentsFactory,
  markCommentUpdatedFactory,
  markCommentViewedFactory,
  updateCommentFactory
} from '@/modules/comments/repositories/comments'
import {
  getTopicGuidsByIdsFactory,
  getTopicRepliesFactory,
  isBcfGuidTakenFactory
} from '@/modules/comments/repositories/bcfArchive'
import {
  BcfArchiveError,
  readBcfArchive,
  writeBcfArchive
} from '@/modules/comments/services/bcfArchive'
import type { BcfVersion } from '@/modules/comments/services/bcfArchive'
import {
  exportBcfTopicsFactory,
  importBcfArchiveFactory
} from '@/modules/comments/services/bcfTransfer'
import {
  getViewerResourcesForCommentFactory,
  getViewerResourcesForCommentsFactory,
  getViewerResourcesFromLegacyIdentifiersFactory
} from '@/modules/core/services/commit/viewerResources'
import {
  getAllBranchCommitsFactory,
  getCommitsAndTheirBranchIdsFactory,
  getSpecificBranchCommitsFactory
} from '@/modules/core/repositories/commits'
import {
  getBranchesByIdsFactory,
  getBranchLatestCommitsFactory,
  getStreamBranchesByNameFactory
} from '@/modules/core/repositories/branches'
import { getStreamObjectsFactory } from '@/modules/core/repositories/objects'
import {
  getViewerResourceGroupsFactory,
  getViewerResourceItemsUngroupedFactory
} from '@/modules/viewer/services/viewerResources'
import {
  getModelHomeSavedViewFactory,
  getSavedViewFactory
} from '@/modules/viewer/repositories/dataLoaders/savedViews'
import type { GraphQLContext } from '@/modules/shared/helpers/typeHelper'
import { getFileSizeLimitMB } from '@/modules/shared/helpers/envHelper'
import { ensureError } from '@speckle/shared'
import { resolveStatusCode } from '@/modules/core/rest/defaultErrorHandler'
import type { Knex } from 'knex'

const exportRoute = '/api/projects/:projectId/bcf/export'
const importRoute = '/api/projects/:projectId/bcf/import'

const actorIdentity = async (ctx: GraphQLContext) => {
  if (!ctx.userId) return undefined
  const user = await ctx.loaders.users.getUser.load(ctx.userId)
  return user?.email || undefined
}

const getViewerResourcesForCommentBuilder = (db: Knex) => {
  const getViewerResourcesFromLegacyIdentifiers =
    getViewerResourcesFromLegacyIdentifiersFactory({
      getViewerResourcesForComments: getViewerResourcesForCommentsFactory({
        getCommentsResources: getCommentsResourcesFactory({ db }),
        getViewerResourcesFromLegacyIdentifiers: (...args) =>
          getViewerResourcesFromLegacyIdentifiers(...args) // recursive dep
      }),
      getCommitsAndTheirBranchIds: getCommitsAndTheirBranchIdsFactory({ db }),
      getStreamObjects: getStreamObjectsFactory({ db })
    })
  return getViewerResourcesForCommentFactory({
    getCommentsResources: getCommentsResourcesFactory({ db }),
    getViewerResourcesFromLegacyIdentifiers
  })
}

const sendError = (req: Request, res: Response, err: unknown) => {
  const error = ensureError(err)
  const status = error instanceof BcfArchiveError ? 400 : resolveStatusCode(error)
  if (status >= 500) req.log.error({ err: error }, 'BCF transfer failed')
  if (!res.headersSent) res.status(status).json({ error: error.message })
}

/** The uploaded file, buffered (BCF archives are small; snapshots dominate). */
const readUpload = (req: Request, maxBytes: number) =>
  new Promise<Buffer>((resolve, reject) => {
    let busboy: Busboy.Busboy
    try {
      busboy = Busboy({ headers: req.headers, limits: { files: 1, fileSize: maxBytes } })
    } catch {
      return reject(new BcfArchiveError('Expected a multipart/form-data upload'))
    }
    let file: Buffer | null = null
    let truncated = false
    const pending: Promise<void>[] = []
    busboy.on('file', (_name, stream) => {
      const chunks: Buffer[] = []
      pending.push(
        new Promise<void>((done) => {
          stream.on('data', (chunk: Buffer) => chunks.push(chunk))
          stream.on('limit', () => (truncated = true))
          stream.on('end', () => {
            file = Buffer.concat(chunks)
            done()
          })
        })
      )
    })
    busboy.on('error', (e) => reject(ensureError(e)))
    busboy.on('finish', async () => {
      await Promise.all(pending)
      if (truncated) return reject(new BcfArchiveError(`The file exceeds ${maxBytes / 1048576} MB`))
      if (!file?.length) return reject(new BcfArchiveError('No BCF file in the upload'))
      resolve(file)
    })
    req.pipe(busboy)
  })

export const getBcfRouter = (): Router => {
  const router = createRouter()

  router.options(exportRoute, corsMiddlewareFactory())
  router.get(exportRoute, corsMiddlewareFactory(), async (req, res) => {
    try {
      const projectId = req.params.projectId
      const ctx = await buildContext({ req })
      throwIfAuthNotOk(
        await ctx.authPolicies.project.canRead({ userId: ctx.userId, projectId })
      )
      if (ctx.userId) await validateScopes(ctx.scopes, Scopes.Streams.Read)

      const version: BcfVersion = req.query.version === '3.0' ? '3.0' : '2.1'
      const resourceIdString =
        typeof req.query.resourceIdString === 'string' ? req.query.resourceIdString : null
      const topicIds =
        typeof req.query.topicIds === 'string'
          ? new Set(req.query.topicIds.split(',').filter(Boolean))
          : null

      const project = await ctx.loaders.streams.getStream.load(projectId)
      const projectDb = await getProjectDbClient({ projectId })
      const { items } = await getPaginatedProjectCommentsPageFactory({ db: projectDb })({
        projectId,
        limit: undefined,
        filter: {
          threadsOnly: true,
          resourceIdString,
          allModelVersions: req.query.loadedVersionsOnly !== 'true'
        }
      })
      const topics = items
        .filter((t) => !topicIds || topicIds.has(t.id))
        // oldest first, as they were raised
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())

      // BCF identities are emails, which only project collaborators may see.
      const isCollaborator = !!ctx.userId && !!(await ctx.loaders.streams.getRole.load(projectId))
      const exportTopics = exportBcfTopicsFactory({
        getTopicReplies: getTopicRepliesFactory({ db: projectDb }),
        getTopicViewpoints: getTopicViewpointsFactory({ db: projectDb }),
        getCommentRelatedTopics: getCommentRelatedTopicsFactory({ db: projectDb }),
        getTopicGuidsByIds: getTopicGuidsByIdsFactory({ db: projectDb }),
        getCommentDocumentReferences: getCommentDocumentReferencesFactory({ db: projectDb }),
        getIdentity: async (userId) => {
          const user = await ctx.loaders.users.getUser.load(userId)
          return (isCollaborator ? user?.email : user?.name) || user?.name || null
        }
      })
      const archive = writeBcfArchive({
        version,
        projectId,
        projectName: project?.name || projectId,
        topics: await exportTopics(
          isCollaborator ? topics : topics.map((t) => ({ ...t, creationAuthor: null, modifiedAuthor: null })),
          version
        )
      })

      const baseName = (project?.name || projectId).replace(/[^\w\- ]+/g, '_').trim() || 'project'
      const extension = version === '3.0' ? 'bcf' : 'bcfzip'
      res.setHeader('Content-Type', 'application/octet-stream')
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${baseName}.${extension}"; filename*=UTF-8''${encodeURIComponent(
          `${project?.name || projectId}.${extension}`
        )}`
      )
      res.setHeader('X-Bcf-Topic-Count', String(topics.length))
      res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-Bcf-Topic-Count')
      res.status(200).send(Buffer.from(archive))
    } catch (e) {
      sendError(req, res, e)
    }
  })

  router.options(importRoute, corsMiddlewareFactory())
  router.post(importRoute, corsMiddlewareFactory(), async (req, res) => {
    try {
      const projectId = req.params.projectId
      const ctx = await buildContext({ req })
      throwIfAuthNotOk(
        await ctx.authPolicies.project.comment.canCreate({ userId: ctx.userId, projectId })
      )
      await validateScopes(ctx.scopes, Scopes.Streams.Write)
      const resourceIdString =
        typeof req.query.resourceIdString === 'string' ? req.query.resourceIdString : ''
      if (!resourceIdString) {
        throw new BcfArchiveError(
          'resourceIdString is required: the model(s) new topics are attached to'
        )
      }

      const upload = await readUpload(req, getFileSizeLimitMB() * 1024 * 1024)
      const archive = readBcfArchive(new Uint8Array(upload))

      const projectDb = await getProjectDbClient({ projectId })
      const repositories = bcfTopicRepositoriesFactory({ db: projectDb })
      const getComment = getCommentFactory({ db: projectDb })
      const validateInputAttachments = validateInputAttachmentsFactory({
        getBlobs: getBlobsFactory({ db: projectDb })
      })
      const getViewerResourcesForComment = getViewerResourcesForCommentBuilder(projectDb)
      const emitEvent = getEventBus().emit
      const insertComments = insertCommentsFactory({ db: projectDb })
      const insertCommentLinks = insertCommentLinksFactory({ db: projectDb })
      const markCommentUpdated = markCommentUpdatedFactory({ db: projectDb })

      const importArchive = importBcfArchiveFactory({
        createTopic: createCommentThreadAndNotifyFactory({
          ...repositories,
          getViewerResourceItemsUngrouped: getViewerResourceItemsUngroupedFactory({
            getViewerResourceGroups: getViewerResourceGroupsFactory({
              getStreamObjects: getStreamObjectsFactory({ db: projectDb }),
              getBranchLatestCommits: getBranchLatestCommitsFactory({ db: projectDb }),
              getStreamBranchesByName: getStreamBranchesByNameFactory({ db: projectDb }),
              getSpecificBranchCommits: getSpecificBranchCommitsFactory({ db: projectDb }),
              getAllBranchCommits: getAllBranchCommitsFactory({ db: projectDb }),
              getBranchesByIds: getBranchesByIdsFactory({ db: projectDb }),
              getSavedView: getSavedViewFactory({ loaders: ctx.loaders }),
              getModelHomeSavedView: getModelHomeSavedViewFactory({ loaders: ctx.loaders })
            })
          }),
          validateInputAttachments,
          insertComments,
          insertCommentLinks,
          markCommentViewed: markCommentViewedFactory({ db: projectDb }),
          emitEvent
        }),
        createComment: createCommentReplyAndNotifyFactory({
          ...repositories,
          getComment,
          validateInputAttachments,
          insertComments,
          insertCommentLinks,
          markCommentUpdated,
          emitEvent,
          getViewerResourcesForComment
        }),
        createViewpoint: createViewpointFactory({
          getComment,
          getViewerResourcesForComment,
          insertTopicViewpoint: repositories.insertTopicViewpoint,
          nextTopicViewpointIndex: repositories.nextTopicViewpointIndex,
          getTopicViewpointByGuid: repositories.getTopicViewpointByGuid,
          markCommentUpdated,
          emitEvent
        }),
        editTopic: editTopicAndNotifyFactory({
          getComment,
          validateInputAttachments,
          updateComment: updateCommentFactory({ db: projectDb }),
          deleteCommentRelatedTopics: deleteCommentRelatedTopicsFactory({ db: projectDb }),
          insertCommentRelatedTopics: repositories.insertCommentRelatedTopics,
          deleteCommentDocumentReferences: deleteCommentDocumentReferencesFactory({
            db: projectDb
          }),
          insertCommentDocumentReferences: repositories.insertCommentDocumentReferences,
          getCommentByGuid: repositories.getCommentByGuid,
          getTopicIdsByGuids: repositories.getTopicIdsByGuids,
          emitEvent
        }),
        getCommentByGuid: repositories.getCommentByGuid,
        getTopicViewpoints: getTopicViewpointsFactory({ db: projectDb }),
        getCommentDocumentReferences: getCommentDocumentReferencesFactory({ db: projectDb }),
        getTopicIdsByGuids: repositories.getTopicIdsByGuids,
        deleteCommentRelatedTopics: deleteCommentRelatedTopicsFactory({ db: projectDb }),
        insertCommentRelatedTopics: repositories.insertCommentRelatedTopics,
        isBcfGuidTaken: isBcfGuidTakenFactory({ db: projectDb })
      })

      const report = await importArchive({
        projectId,
        resourceIdString,
        archive,
        userId: ctx.userId!,
        actorIdentity: await actorIdentity(ctx)
      })
      req.log.info(
        {
          projectId,
          bcfVersion: report.version,
          topicsCreated: report.topicsCreated,
          topicsUpdated: report.topicsUpdated,
          topicsFailed: report.topicsFailed
        },
        'BCF import: {topicsCreated} topics created, {topicsUpdated} updated, {topicsFailed} failed'
      )
      res.status(200).json(report)
    } catch (e) {
      sendError(req, res, e)
    }
  })

  return router
}
