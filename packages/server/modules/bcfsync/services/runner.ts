/**
 * Runs a sync of one connection outside any request: as the user who created
 * the connection (their right to comment on the project is checked on every
 * run), against the project's own database.
 */
import type { Knex } from 'knex'
import { db } from '@/db/knex'
import { buildContext } from '@/modules/shared/middleware'
import { throwIfAuthNotOk } from '@/modules/shared/helpers/errorHelper'
import { BadRequestError, NotFoundError } from '@/modules/shared/errors'
import { getProjectDbClient } from '@/modules/multiregion/utils/dbSelector'
import { getEventBus } from '@/modules/shared/services/eventBus'
import { getBlobsFactory } from '@/modules/blobstorage/repositories'
import { CommentEvents } from '@/modules/comments/domain/events'
import { validateInputAttachmentsFactory } from '@/modules/comments/services/commentTextService'
import {
  createCommentReplyAndNotifyFactory,
  createCommentThreadAndNotifyFactory,
  createViewpointFactory,
  deleteCommentAndNotifyFactory,
  deleteViewpointFactory,
  editCommentAndNotifyFactory,
  editTopicAndNotifyFactory
} from '@/modules/comments/services/management'
import {
  bcfTopicRepositoriesFactory,
  deleteCommentDocumentReferencesFactory,
  deleteCommentFactory,
  deleteCommentRelatedTopicsFactory,
  deleteTopicAndRepliesFactory,
  deleteTopicViewpointFactory,
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
import {
  getBcfConnectionFactory,
  updateBcfConnectionFactory
} from '@/modules/bcfsync/repositories/connections'
import {
  deleteBcfSyncLinksFactory,
  getBcfSyncLinksFactory,
  saveBcfSyncLinksFactory
} from '@/modules/bcfsync/repositories/links'
import { makeBcfClientFactory } from '@/modules/bcfsync/services/connections'
import { fetchRemoteTopics } from '@/modules/bcfsync/services/remoteTopics'
import { readLocalSideFactory, remoteSideTopic } from '@/modules/bcfsync/services/sides'
import { isMassDelete, planSync, summarize } from '@/modules/bcfsync/services/planner'
import { executeSync, type SyncRunResult } from '@/modules/bcfsync/services/engine'
import { localWriterFactory, remoteWriterFactory } from '@/modules/bcfsync/services/writers'
import { extensionLists, type BcfExtensionLists } from '@/modules/bcfsync/services/extensions'
import type { SyncOp } from '@/modules/bcfsync/domain/sync'
import { ensureError } from '@speckle/shared'

export interface BcfSyncReport {
  dryRun: boolean
  counts: Record<string, number>
  conflicts: number
  /** Remote topics left alone because their guid is used elsewhere here. */
  skipped: Array<{ guid: string; title: string; reason: string }>
  operations: Array<SyncOp & { title: string }>
  /** Values the BCF server does not allow, and what was sent instead. */
  warnings?: string[]
  /** Set when the plan was carried out. */
  applied?: number
  failed?: SyncRunResult['failed']
}

const buildLocalServices = (projectDb: Knex, ctx: GraphQLContext) => {
  const repositories = bcfTopicRepositoriesFactory({ db: projectDb })
  const getComment = getCommentFactory({ db: projectDb })
  const validateInputAttachments = validateInputAttachmentsFactory({
    getBlobs: getBlobsFactory({ db: projectDb })
  })
  const getViewerResourcesFromLegacyIdentifiers =
    getViewerResourcesFromLegacyIdentifiersFactory({
      getViewerResourcesForComments: getViewerResourcesForCommentsFactory({
        getCommentsResources: getCommentsResourcesFactory({ db: projectDb }),
        getViewerResourcesFromLegacyIdentifiers: (...args) =>
          getViewerResourcesFromLegacyIdentifiers(...args) // recursive dep
      }),
      getCommitsAndTheirBranchIds: getCommitsAndTheirBranchIdsFactory({ db: projectDb }),
      getStreamObjects: getStreamObjectsFactory({ db: projectDb })
    })
  const getViewerResourcesForComment = getViewerResourcesForCommentFactory({
    getCommentsResources: getCommentsResourcesFactory({ db: projectDb }),
    getViewerResourcesFromLegacyIdentifiers
  })
  const emitEvent = getEventBus().emit
  const insertComments = insertCommentsFactory({ db: projectDb })
  const insertCommentLinks = insertCommentLinksFactory({ db: projectDb })
  const markCommentUpdated = markCommentUpdatedFactory({ db: projectDb })
  const updateComment = updateCommentFactory({ db: projectDb })
  const deleteTopicAndReplies = deleteTopicAndRepliesFactory({ db: projectDb })

  return {
    repositories,
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
    deleteViewpoint: deleteViewpointFactory({
      getComment,
      deleteTopicViewpoint: deleteTopicViewpointFactory({ db: projectDb }),
      markCommentUpdated,
      emitEvent
    }),
    editTopic: editTopicAndNotifyFactory({
      getComment,
      validateInputAttachments,
      updateComment,
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
    editComment: editCommentAndNotifyFactory({
      getComment,
      validateInputAttachments,
      updateComment,
      getTopicViewpointByGuid: repositories.getTopicViewpointByGuid,
      getCommentByGuid: repositories.getCommentByGuid,
      emitEvent
    }),
    deleteComment: deleteCommentAndNotifyFactory({
      getComment,
      deleteComment: deleteCommentFactory({ db: projectDb }),
      markCommentUpdated,
      emitEvent
    }),
    /** As the topicMutations.delete resolver does it. */
    deleteTopic: async (topicId: string, userId: string) => {
      const topic = await getComment({ id: topicId })
      const deleted = await deleteTopicAndReplies(topicId)
      if (deleted && topic)
        await emitEvent({
          eventName: CommentEvents.Deleted,
          payload: { comment: topic, userId }
        })
    }
  }
}

const running = new Set<string>()

export const runBcfSync = async (
  connectionId: string,
  opts: { dryRun: boolean; allowMassDelete?: boolean }
): Promise<BcfSyncReport> => {
  if (running.has(connectionId))
    throw new BadRequestError('A sync of this connection is already running')
  running.add(connectionId)

  const getConnection = getBcfConnectionFactory({ db })
  const updateConnection = updateBcfConnectionFactory({ db })
  try {
    const connection = await getConnection(connectionId)
    if (!connection) throw new NotFoundError('Connection not found')
    const remoteProjectId = connection.remoteProjectId
    if (!remoteProjectId) throw new BadRequestError('Pick the BCF project to sync with first')
    if (!connection.createdBy)
      throw new BadRequestError('The user who set up this connection no longer exists')
    const { projectId, modelId, createdBy: userId } = connection

    const ctx = await buildContext({ authContext: { auth: true, userId } })
    throwIfAuthNotOk(await ctx.authPolicies.project.comment.canCreate({ userId, projectId }))
    const user = await ctx.loaders.users.getUser.load(userId)

    const projectDb = await getProjectDbClient({ projectId })
    const services = buildLocalServices(projectDb, ctx)
    const isBcfGuidTaken = isBcfGuidTakenFactory({ db: projectDb })
    const client = await makeBcfClientFactory({ getConnection, updateConnection })(connection)

    const readLocal = readLocalSideFactory({
      getModelTopics: async () =>
        (
          await getPaginatedProjectCommentsPageFactory({ db: projectDb })({
            projectId,
            limit: undefined,
            filter: { threadsOnly: true, resourceIdString: modelId, allModelVersions: true }
          })
        ).items,
      getTopicReplies: getTopicRepliesFactory({ db: projectDb }),
      getTopicViewpoints: getTopicViewpointsFactory({ db: projectDb }),
      getCommentRelatedTopics: getCommentRelatedTopicsFactory({ db: projectDb }),
      getTopicGuidsByIds: getTopicGuidsByIdsFactory({ db: projectDb }),
      getCommentDocumentReferences: getCommentDocumentReferencesFactory({ db: projectDb }),
      getIdentity: async (id) => (await ctx.loaders.users.getUser.load(id))?.email || null
    })

    try {
      const links = await getBcfSyncLinksFactory({ db })(connection.id)
      const local = await readLocal()
      const localGuids = new Set(local.map((t) => t.guid))
      const linkedGuids = new Set(links.filter((l) => l.kind === 'topic').map((l) => l.guid))

      const remoteAll = (
        await fetchRemoteTopics({
          client,
          remoteProjectId,
          haveViewpoint: (guid) => isBcfGuidTaken('viewpoint', guid)
        })
      ).map(remoteSideTopic)
      // A remote topic whose guid is already used here outside this model
      // (another model or project) cannot be created; leave it alone.
      const skipped: BcfSyncReport['skipped'] = []
      const remote = []
      for (const t of remoteAll) {
        if (!localGuids.has(t.guid) && !linkedGuids.has(t.guid) && (await isBcfGuidTaken('comment', t.guid))) {
          skipped.push({
            guid: t.guid,
            title: t.state.title,
            reason: 'a topic with this guid exists in another model or project'
          })
        } else remote.push(t)
      }

      const ops = planSync({
        local,
        remote,
        links,
        options: {
          allowPull: connection.direction !== 'push',
          allowPush: connection.direction !== 'pull'
        }
      })
      const titles = new Map([...remote, ...local].map((t) => [t.guid, t.state.title]))
      const visible = ops.filter((o) => o.action !== 'link' && o.action !== 'unlink')
      const report: BcfSyncReport = {
        dryRun: opts.dryRun,
        ...summarize(ops),
        skipped,
        operations: visible.map((o) => ({
          ...o,
          title: titles.get(o.topicGuid ?? o.guid) || ''
        }))
      }
      if (opts.dryRun) return report

      if (isMassDelete(ops, links) && !opts.allowMassDelete)
        throw new BadRequestError(
          'This sync would delete more than half of the synced topics. Check a dry run, then sync manually allowing it.'
        )

      // The server's allowed values; without them anything is sent as is.
      let extensions: BcfExtensionLists = {}
      if (connection.direction !== 'pull') {
        try {
          extensions = extensionLists(await client.getExtensions(remoteProjectId))
        } catch {
          // optional in practice
        }
      }
      const warnings: string[] = []

      const result = await executeSync({
        ops,
        local,
        remote,
        localWriter: localWriterFactory({
          projectId,
          modelId,
          userId,
          actorIdentity: user?.email || undefined,
          db: projectDb,
          ...services,
          deleteTopic: (id) => services.deleteTopic(id, userId)
        }),
        remoteWriter: remoteWriterFactory({
          client,
          remoteProjectId,
          extensions,
          warn: (m) => warnings.push(m)
        }),
        readLocal,
        saveLinks: (l) => saveBcfSyncLinksFactory({ db })(connection.id, l),
        deleteLinks: (k) => deleteBcfSyncLinksFactory({ db })(connection.id, k)
      })
      report.applied = result.applied
      report.failed = result.failed
      report.warnings = warnings

      await updateConnection(connection.id, {
        lastSyncAt: new Date(),
        lastError: result.failed.length
          ? `${result.failed.length} item(s) failed, e.g. ${result.failed[0].error}`
          : null,
        lastSyncResult: {
          at: new Date().toISOString(),
          counts: report.counts,
          conflicts: report.conflicts,
          skipped: skipped.length,
          applied: result.applied,
          failed: result.failed.slice(0, 20),
          warnings: warnings.slice(0, 20)
        }
      })
      return report
    } catch (e) {
      // Kept for the UI; the connection stays active and retries next run.
      await updateConnection(connection.id, { lastError: ensureError(e).message })
      throw e
    }
  } finally {
    running.delete(connectionId)
  }
}
