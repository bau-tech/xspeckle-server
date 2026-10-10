import { ensureError } from '@speckle/shared'
import type {
  BimSnippetInput,
  CreateCommentInput,
  CreateTopicInput,
  DocumentReferenceInput,
  UpdateCommentInput,
  UpdateTopicInput,
  ViewpointInput
} from '@/modules/core/graph/generated/graphql'
import {
  CommentCreateError,
  CommentNotFoundError,
  CommentUpdateError
} from '@/modules/comments/errors'
import {
  buildCommentTextFromInput,
  buildTopicDescriptionFromInput
} from '@/modules/comments/services/commentTextService'
import type {
  BcfBimSnippet,
  BcfViewpointData,
  CommentDocumentReferenceRecord,
  CommentLinkRecord,
  CommentLinkResourceType,
  CommentRecord,
  CommentRelatedTopicRecord
} from '@/modules/comments/helpers/types'
import type { DataStruct } from '@/modules/comments/services/data'
import {
  inputToDataStruct,
  combineViewerStateInputs
} from '@/modules/comments/services/data'
import {
  bcfViewpointFromInput,
  bcfViewpointFromState,
  bcfViewpointToFlatInput,
  emptyBcfViewpoint,
  normalizeSnapshotType
} from '@/modules/comments/services/bcfViewpoint'
import type { BcfViewpointInputData } from '@/modules/comments/services/bcfViewpoint'
import type { SmartTextEditorValueSchema } from '@/modules/core/services/richTextEditorService'
import type { Merge } from 'type-fest'
import type {
  AssignNextTopicIndex,
  CreateCommentReplyAndNotify,
  CreateCommentThreadAndNotify,
  CreateViewpoint,
  DeleteCommentAndNotify,
  DeleteCommentDocumentReferences,
  DeleteCommentRelatedTopics,
  DeleteTopicViewpoint,
  DeleteViewpoint,
  EditCommentAndNotify,
  EditTopicAndNotify,
  GetComment,
  GetCommentByGuid,
  GetTopicIdsByGuids,
  GetTopicViewpointByGuid,
  GetViewerResourcesForComment,
  InsertCommentDocumentReferences,
  InsertCommentLinks,
  InsertCommentPayload,
  InsertCommentRelatedTopics,
  InsertComments,
  InsertTopicViewpoint,
  MarkCommentUpdated,
  MarkCommentViewed,
  NextTopicViewpointIndex,
  UpdateComment,
  ValidateInputAttachments
} from '@/modules/comments/domain/operations'
import type { EventBusEmit } from '@/modules/shared/services/eventBus'
import { CommentEvents } from '@/modules/comments/domain/events'
import type { GetViewerResourceItemsUngrouped } from '@/modules/viewer/domain/operations/resources'
import { viewerResourcesToString } from '@/modules/viewer/services/viewerResources'
import type { Nullable } from '@/modules/shared/helpers/typeHelper'
import { isSerializedViewerState } from '@speckle/shared/viewer/state'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** BCF guids are UUIDs (the DB column is uuid, so anything else would 500). */
const assertBcfGuid = (guid: string, what: string) => {
  if (!UUID_RE.test(guid)) {
    throw new CommentCreateError(`${what} guid must be a UUID`)
  }
  return guid.toLowerCase()
}

/* eslint-disable camelcase -- BCF's own snake_case wire format */
const bimSnippetFromInput = (
  input: BimSnippetInput | null | undefined
): Nullable<BcfBimSnippet> =>
  input
    ? {
        snippet_type: input.snippetType,
        is_external: input.isExternal,
        reference: input.reference,
        reference_schema: input.referenceSchema
      }
    : null
/* eslint-enable camelcase */

const documentReferenceRows = (
  topicId: string,
  refs: DocumentReferenceInput[]
): CommentDocumentReferenceRecord[] =>
  refs.map((ref) => ({
    id: '',
    topicId,
    documentGuid: ref.documentGuid ?? null,
    url: ref.url ?? null,
    description: ref.description ?? null,
    ...(ref.guid ? { guid: assertBcfGuid(ref.guid, 'Document reference') } : {})
  }))

/** "data:image/jpeg;base64,..." -> 'jpg'; otherwise the declared type. */
const snapshotTypeOf = (screenshot: string, declared?: Nullable<string>) => {
  const dataUri = /^data:image\/(png|jpe?g);/i.exec(screenshot)
  return normalizeSnapshotType(declared || dataUri?.[1] || 'png')
}

/**
 * Builds the stored form of one viewpoint -- the BCF viewpoint itself plus
 * the Speckle viewer state -- from whatever a caller sent: a Speckle viewer
 * capture (`viewerState`), a BCF viewpoint (`viewpoint`, e.g. synced from
 * another BCF server), both, or just a snapshot. Each half is derived from
 * the other when missing. Returns null when there's nothing to store.
 */
const buildViewpointPayload = (params: {
  viewpoint?: Nullable<ViewpointInput>
  viewerState?: unknown
  screenshot?: Nullable<string>
  projectId: string
  resourceIdString: string
}): Nullable<{
  data: Nullable<DataStruct>
  bcf: BcfViewpointData
  screenshot: Nullable<string>
  snapshotType: Nullable<string>
  guid?: string
  index: Nullable<number>
}> => {
  const vp = (params.viewpoint || null) as Nullable<BcfViewpointInputData>
  let bcf = vp ? bcfViewpointFromInput(vp) : null
  const flat = bcf ? bcfViewpointToFlatInput(bcf) : null

  const combinedState = combineViewerStateInputs({
    viewerState: params.viewerState,
    // Only overlay the BCF camera when there is one: combineViewerStateInputs
    // would otherwise overwrite a real viewerState camera with zeros. And
    // keep a given viewerState's own selection -- it's keyed by the viewer's
    // object ids, which is what the viewer highlights; the BCF components
    // (IFC GUIDs) are kept in `bcf` regardless.
    viewpoint: flat?.cameraViewPoint
      ? isSerializedViewerState(params.viewerState)
        ? { ...flat, selection: [] }
        : flat
      : null,
    projectId: params.projectId,
    resourceIdString: params.resourceIdString
  })
  const data = inputToDataStruct(combinedState)

  if (!bcf && !data && !params.screenshot) return null

  if (!bcf) {
    bcf = data ? bcfViewpointFromState(data.state) : emptyBcfViewpoint()
  } else if (!bcf.perspective_camera && !bcf.orthogonal_camera && data) {
    const { perspective_camera: perspective, orthogonal_camera: orthogonal } =
      bcfViewpointFromState(data.state)
    // eslint-disable-next-line camelcase -- BCF wire format
    bcf = { ...bcf, perspective_camera: perspective, orthogonal_camera: orthogonal }
  }

  return {
    data,
    bcf,
    screenshot: params.screenshot || null,
    snapshotType: params.screenshot
      ? snapshotTypeOf(params.screenshot, vp?.snapshotType)
      : null,
    ...(vp?.guid ? { guid: assertBcfGuid(vp.guid, 'Viewpoint') } : {}),
    index: vp?.index ?? null
  }
}

/** relatedTopicIds + relatedTopicGuids -> one deduplicated id list, or undefined. */
const resolveRelatedTopicIds = async (params: {
  streamId: string
  ids?: Nullable<string[]>
  guids?: Nullable<string[]>
  getTopicIdsByGuids: GetTopicIdsByGuids
}): Promise<string[] | undefined> => {
  if (params.ids === undefined && params.guids === undefined) return undefined
  const byGuid = params.guids?.length
    ? await params.getTopicIdsByGuids({
        streamId: params.streamId,
        guids: params.guids.filter((g) => UUID_RE.test(g)).map((g) => g.toLowerCase())
      })
    : []
  return [...new Set([...(params.ids || []), ...byGuid])]
}

export const createCommentThreadAndNotifyFactory =
  (deps: {
    getViewerResourceItemsUngrouped: GetViewerResourceItemsUngrouped
    validateInputAttachments: ValidateInputAttachments
    insertComments: InsertComments
    insertCommentLinks: InsertCommentLinks
    markCommentViewed: MarkCommentViewed
    assignNextTopicIndex: AssignNextTopicIndex
    insertCommentRelatedTopics: InsertCommentRelatedTopics
    insertCommentDocumentReferences: InsertCommentDocumentReferences
    insertTopicViewpoint: InsertTopicViewpoint
    getCommentByGuid: GetCommentByGuid
    getTopicIdsByGuids: GetTopicIdsByGuids
    emitEvent: EventBusEmit
  }): CreateCommentThreadAndNotify =>
  async (input: CreateTopicInput, userId, options) => {
    const [resources] = await Promise.all([
      deps.getViewerResourceItemsUngrouped({ ...input, loadedVersionsOnly: true }),
      deps.validateInputAttachments(input.projectId, input.content.blobIds || [])
    ])
    if (!resources.length) {
      throw new CommentCreateError(
        "Resource ID string doesn't resolve to any valid resources for the specified project/stream"
      )
    }

    const guid = input.guid ? assertBcfGuid(input.guid, 'Topic') : undefined
    if (guid && (await deps.getCommentByGuid({ streamId: input.projectId, guid }))) {
      throw new CommentCreateError(`A topic with guid ${guid} already exists`)
    }

    const viewpoint = buildViewpointPayload({
      viewpoint: input.viewpoint,
      viewerState: input.viewerState,
      screenshot: input.screenshot,
      projectId: input.projectId,
      resourceIdString: input.resourceIdString
    })
    const index = await deps.assignNextTopicIndex(input.projectId)
    const createdAt = input.creationDate
      ? new Date(input.creationDate)
      : options?.createdAt

    const commentPayload: InsertCommentPayload = {
      streamId: input.projectId,
      authorId: userId,
      text: buildTopicDescriptionFromInput({
        doc: input.content.doc,
        blobIds: input.content.blobIds || undefined
      }),
      screenshot: input.screenshot,
      // The Speckle viewer's own anchoring state for this topic.
      data: viewpoint?.data ?? null,
      title: input.title,
      topicType: input.topicType,
      topicStatus: input.topicStatus,
      priority: input.priority,
      stage: input.stage,
      labels: input.labels,
      dueDate: input.dueDate ? new Date(input.dueDate) : null,
      assignedTo: input.assignedTo,
      index,
      ...(guid ? { guid } : {}),
      creationAuthor: input.creationAuthor ?? options?.actorIdentity ?? null,
      modifiedAuthor: input.modifiedAuthor ?? null,
      modifiedDate: input.modifiedDate ? new Date(input.modifiedDate) : null,
      referenceLinks: input.referenceLinks ?? null,
      bimSnippet: bimSnippetFromInput(input.bimSnippet),
      viewpointGuid: null,
      ...(createdAt ? { createdAt, updatedAt: createdAt } : {})
    }

    const relatedTopicIds = await resolveRelatedTopicIds({
      streamId: input.projectId,
      ids: input.relatedTopicIds,
      guids: input.relatedTopicGuids,
      getTopicIdsByGuids: deps.getTopicIdsByGuids
    })

    let comment: CommentRecord
    try {
      // i know we're loosing transactional consistency...
      // it can be added back with the commandFactory on top of a service
      const [insertedComment] = await deps.insertComments([commentPayload])

      const links: CommentLinkRecord[] = resources.map((r) => {
        let resourceId = r.objectId
        let resourceType: CommentLinkResourceType = 'object'
        if (r.versionId) {
          resourceId = r.versionId
          resourceType = 'commit'
        }

        return {
          commentId: insertedComment.id,
          resourceId,
          resourceType
        }
      })
      await deps.insertCommentLinks(links)

      if (viewpoint) {
        await deps.insertTopicViewpoint({
          id: '',
          topicId: insertedComment.id,
          authorId: userId,
          ...viewpoint,
          index: viewpoint.index ?? 1,
          ...(createdAt ? { createdAt } : {})
        })
      }

      if (relatedTopicIds?.length) {
        const relatedRows: CommentRelatedTopicRecord[] = relatedTopicIds.map(
          (relatedTopicId) => ({ topicId: insertedComment.id, relatedTopicId })
        )
        await deps.insertCommentRelatedTopics(relatedRows)
      }

      if (input.documentReferences?.length) {
        await deps.insertCommentDocumentReferences(
          documentReferenceRows(insertedComment.id, input.documentReferences)
        )
      }

      comment = insertedComment
    } catch (e) {
      throw new CommentCreateError('Comment creation failed', { cause: ensureError(e) })
    }

    // Mark as viewed and emit events
    await Promise.all([
      deps.markCommentViewed(comment.id, userId),
      deps.emitEvent({
        eventName: CommentEvents.Created,
        payload: {
          comment,
          input,
          isThread: true,
          resourceItems: resources
        }
      })
    ])

    return comment
  }

export const createCommentReplyAndNotifyFactory =
  (deps: {
    getComment: GetComment
    validateInputAttachments: ValidateInputAttachments
    insertComments: InsertComments
    insertCommentLinks: InsertCommentLinks
    markCommentUpdated: MarkCommentUpdated
    emitEvent: EventBusEmit
    getViewerResourcesForComment: GetViewerResourcesForComment
    getCommentByGuid: GetCommentByGuid
    getTopicViewpointByGuid: GetTopicViewpointByGuid
    insertTopicViewpoint: InsertTopicViewpoint
    nextTopicViewpointIndex: NextTopicViewpointIndex
  }): CreateCommentReplyAndNotify =>
  async (input: CreateCommentInput, userId: string, options) => {
    const thread = await deps.getComment({ id: input.topicId, userId })
    if (!thread) {
      throw new CommentCreateError('Comment creation failed due to nonexistant topic')
    }
    await deps.validateInputAttachments(thread.streamId, input.content.blobIds || [])

    const guid = input.guid ? assertBcfGuid(input.guid, 'Comment') : undefined
    if (guid && (await deps.getCommentByGuid({ streamId: thread.streamId, guid }))) {
      throw new CommentCreateError(`A comment with guid ${guid} already exists`)
    }

    // BCF: a comment refers to one of its topic's viewpoints. Either an
    // existing one (viewpointGuid), or a new one added to the topic here.
    let viewpointGuid: Nullable<string> = null
    let newViewpoint: ReturnType<typeof buildViewpointPayload> = null
    if (input.viewpointGuid) {
      const existing = await deps.getTopicViewpointByGuid({
        topicId: thread.id,
        guid: assertBcfGuid(input.viewpointGuid, 'Viewpoint')
      })
      if (!existing) {
        throw new CommentCreateError('viewpointGuid is not a viewpoint of this topic')
      }
      viewpointGuid = existing.guid
    } else if (input.viewpoint || input.viewerState) {
      const resourceItems = await deps.getViewerResourcesForComment(
        thread.streamId,
        thread.id
      )
      newViewpoint = buildViewpointPayload({
        viewpoint: input.viewpoint,
        viewerState: input.viewerState,
        projectId: thread.streamId,
        resourceIdString: viewerResourcesToString(resourceItems)
      })
    }

    const createdAt = input.creationDate ? new Date(input.creationDate) : undefined
    let reply: CommentRecord
    try {
      if (newViewpoint) {
        const inserted = await deps.insertTopicViewpoint({
          id: '',
          topicId: thread.id,
          authorId: userId,
          ...newViewpoint,
          index: newViewpoint.index ?? (await deps.nextTopicViewpointIndex(thread.id)),
          ...(createdAt ? { createdAt } : {})
        })
        viewpointGuid = inserted.guid
      }

      const commentPayload: InsertCommentPayload = {
        streamId: thread.streamId,
        authorId: userId,
        text: buildCommentTextFromInput({
          doc: input.content.doc,
          blobIds: input.content.blobIds || undefined
        }),
        parentComment: thread.id,
        data: newViewpoint?.data ?? null,
        ...(guid ? { guid } : {}),
        creationAuthor: input.creationAuthor ?? options?.actorIdentity ?? null,
        modifiedAuthor: input.modifiedAuthor ?? null,
        modifiedDate: input.modifiedDate ? new Date(input.modifiedDate) : null,
        viewpointGuid,
        ...(createdAt ? { createdAt, updatedAt: createdAt } : {})
      }

      const [insertedReply] = await deps.insertComments([commentPayload])
      const links: CommentLinkRecord[] = [
        { resourceType: 'comment', resourceId: thread.id, commentId: insertedReply.id }
      ]
      await deps.insertCommentLinks(links)

      reply = insertedReply
    } catch (e) {
      throw new CommentCreateError('Comment creation failed', { cause: ensureError(e) })
    }

    // Mark parent topic updated and emit events
    const resourceItems = await deps.getViewerResourcesForComment(
      reply.streamId,
      reply.id
    )
    await Promise.all([
      deps.markCommentUpdated(thread.id),
      deps.emitEvent({
        eventName: CommentEvents.Created,
        payload: {
          comment: reply,
          input,
          isThread: false,
          resourceItems
        }
      })
    ])

    return reply
  }

/**
 * Adds a viewpoint to an existing topic's list (BCF viewpoint POST).
 */
export const createViewpointFactory =
  (deps: {
    getComment: GetComment
    getViewerResourcesForComment: GetViewerResourcesForComment
    insertTopicViewpoint: InsertTopicViewpoint
    nextTopicViewpointIndex: NextTopicViewpointIndex
    getTopicViewpointByGuid: GetTopicViewpointByGuid
    markCommentUpdated: MarkCommentUpdated
    emitEvent: EventBusEmit
  }): CreateViewpoint =>
  async (input, userId) => {
    const topic = await deps.getComment({ id: input.topicId, userId })
    if (!topic || topic.parentComment) {
      throw new CommentCreateError('Viewpoint creation failed due to nonexistant topic')
    }

    // formatSerializedViewerState requires a real, non-empty
    // resources.request.resourceIdString -- reuse the topic's own linked
    // resources rather than the topic's original resourceIdString, which
    // isn't itself a stored field.
    const resourceItems = await deps.getViewerResourcesForComment(
      topic.streamId,
      topic.id
    )
    const viewpoint = buildViewpointPayload({
      viewpoint: input.viewpoint,
      viewerState: input.viewerState,
      screenshot: input.screenshot,
      projectId: topic.streamId,
      resourceIdString: viewerResourcesToString(resourceItems)
    })
    if (!viewpoint) {
      throw new CommentCreateError(
        'Viewpoint creation failed: neither viewpoint, viewerState nor screenshot carried any usable data'
      )
    }
    if (
      viewpoint.guid &&
      (await deps.getTopicViewpointByGuid({ topicId: topic.id, guid: viewpoint.guid }))
    ) {
      throw new CommentCreateError(
        `A viewpoint with guid ${viewpoint.guid} already exists`
      )
    }

    const row = await deps.insertTopicViewpoint({
      id: '',
      topicId: topic.id,
      authorId: userId,
      ...viewpoint,
      index: viewpoint.index ?? (await deps.nextTopicViewpointIndex(topic.id))
    })

    await deps.markCommentUpdated(topic.id)
    await deps.emitEvent({
      eventName: CommentEvents.Updated,
      payload: { previousComment: topic, newComment: topic, userId }
    })
    return row
  }

export const deleteViewpointFactory =
  (deps: {
    getComment: GetComment
    deleteTopicViewpoint: DeleteTopicViewpoint
    markCommentUpdated: MarkCommentUpdated
    emitEvent: EventBusEmit
  }): DeleteViewpoint =>
  async (input, userId) => {
    const topic = await deps.getComment({ id: input.topicId })
    if (!topic || topic.parentComment) throw new CommentNotFoundError('Topic not found')
    if (!UUID_RE.test(input.viewpointGuid)) return false

    const deleted = await deps.deleteTopicViewpoint({
      topicId: topic.id,
      guid: input.viewpointGuid.toLowerCase()
    })
    if (deleted) {
      await deps.markCommentUpdated(topic.id)
      await deps.emitEvent({
        eventName: CommentEvents.Updated,
        payload: { previousComment: topic, newComment: topic, userId }
      })
    }
    return deleted
  }

export const editTopicAndNotifyFactory =
  (deps: {
    getComment: GetComment
    validateInputAttachments: ValidateInputAttachments
    updateComment: UpdateComment
    deleteCommentRelatedTopics: DeleteCommentRelatedTopics
    insertCommentRelatedTopics: InsertCommentRelatedTopics
    deleteCommentDocumentReferences: DeleteCommentDocumentReferences
    insertCommentDocumentReferences: InsertCommentDocumentReferences
    getCommentByGuid: GetCommentByGuid
    getTopicIdsByGuids: GetTopicIdsByGuids
    emitEvent: EventBusEmit
  }): EditTopicAndNotify =>
  async (input: UpdateTopicInput, userId: string, options) => {
    const topic = await deps.getComment({ id: input.topicId, userId })
    if (!topic) {
      throw new CommentUpdateError('Topic update failed due to nonexistant topic')
    }
    if (topic.parentComment) {
      throw new CommentUpdateError('Cannot update a comment as if it were a topic')
    }

    const updatePayload: Merge<
      Partial<CommentRecord>,
      { text?: SmartTextEditorValueSchema }
    > = {}
    if (input.content) {
      await deps.validateInputAttachments(topic.streamId, input.content.blobIds || [])
      updatePayload.text = buildTopicDescriptionFromInput({
        doc: input.content.doc,
        blobIds: input.content.blobIds || undefined
      })
    }
    if (input.guid) {
      const guid = assertBcfGuid(input.guid, 'Topic')
      if (guid !== topic.guid) {
        const taken = await deps.getCommentByGuid({ streamId: topic.streamId, guid })
        if (taken) throw new CommentUpdateError(`guid ${guid} is already in use`)
        updatePayload.guid = guid
      }
    }
    if (input.title !== undefined) updatePayload.title = input.title
    if (input.topicType !== undefined) updatePayload.topicType = input.topicType
    if (input.topicStatus !== undefined) updatePayload.topicStatus = input.topicStatus
    if (input.priority !== undefined) updatePayload.priority = input.priority
    if (input.stage !== undefined) updatePayload.stage = input.stage
    if (input.labels !== undefined) updatePayload.labels = input.labels
    if (input.dueDate !== undefined) {
      updatePayload.dueDate = input.dueDate ? new Date(input.dueDate) : null
    }
    if (input.assignedTo !== undefined) updatePayload.assignedTo = input.assignedTo
    if (input.referenceLinks !== undefined)
      updatePayload.referenceLinks = input.referenceLinks
    if (input.bimSnippet !== undefined)
      updatePayload.bimSnippet = bimSnippetFromInput(input.bimSnippet)
    // BCF modified_author/modified_date: the acting user and now, unless a
    // sync supplied the source's own values.
    updatePayload.modifiedAuthor =
      input.modifiedAuthor ?? options?.actorIdentity ?? topic.modifiedAuthor
    updatePayload.modifiedDate = input.modifiedDate
      ? new Date(input.modifiedDate)
      : new Date()

    const updatedComment = await deps.updateComment(topic.id, updatePayload)

    const relatedTopicIds = await resolveRelatedTopicIds({
      streamId: topic.streamId,
      ids: input.relatedTopicIds,
      guids: input.relatedTopicGuids,
      getTopicIdsByGuids: deps.getTopicIdsByGuids
    })
    if (relatedTopicIds !== undefined) {
      await deps.deleteCommentRelatedTopics(topic.id)
      if (relatedTopicIds.length) {
        await deps.insertCommentRelatedTopics(
          relatedTopicIds.map((relatedTopicId) => ({
            topicId: topic.id,
            relatedTopicId
          }))
        )
      }
    }

    if (input.documentReferences !== undefined) {
      await deps.deleteCommentDocumentReferences(topic.id)
      if (input.documentReferences?.length) {
        await deps.insertCommentDocumentReferences(
          documentReferenceRows(topic.id, input.documentReferences)
        )
      }
    }

    await deps.emitEvent({
      eventName: CommentEvents.Updated,
      payload: {
        previousComment: topic,
        newComment: updatedComment!,
        userId
      }
    })

    return updatedComment
  }

export const editCommentAndNotifyFactory =
  (deps: {
    getComment: GetComment
    validateInputAttachments: ValidateInputAttachments
    updateComment: UpdateComment
    getTopicViewpointByGuid: GetTopicViewpointByGuid
    getCommentByGuid: GetCommentByGuid
    emitEvent: EventBusEmit
  }): EditCommentAndNotify =>
  async (input: UpdateCommentInput, userId: string, options) => {
    const comment = await deps.getComment({ id: input.commentId, userId })
    if (!comment) {
      throw new CommentUpdateError('Comment update failed due to nonexistant comment')
    }
    // Who may edit is decided by the project's comment edit policy (any
    // project member, as on a BCF server) -- not re-checked here.

    await deps.validateInputAttachments(comment.streamId, input.content.blobIds || [])
    const updatePayload: Merge<
      Partial<CommentRecord>,
      { text?: SmartTextEditorValueSchema }
    > = {
      text: buildCommentTextFromInput({
        doc: input.content.doc,
        blobIds: input.content.blobIds || undefined
      }),
      modifiedAuthor:
        input.modifiedAuthor ?? options?.actorIdentity ?? comment.modifiedAuthor,
      modifiedDate: input.modifiedDate ? new Date(input.modifiedDate) : new Date()
    }
    if (input.guid) {
      const guid = assertBcfGuid(input.guid, 'Comment')
      if (guid !== comment.guid) {
        const taken = await deps.getCommentByGuid({ streamId: comment.streamId, guid })
        if (taken) throw new CommentUpdateError(`guid ${guid} is already in use`)
        updatePayload.guid = guid
      }
    }
    if (input.viewpointGuid !== undefined) {
      if (input.viewpointGuid === null) {
        updatePayload.viewpointGuid = null
      } else {
        const vp = comment.parentComment
          ? await deps.getTopicViewpointByGuid({
              topicId: comment.parentComment,
              guid: assertBcfGuid(input.viewpointGuid, 'Viewpoint')
            })
          : undefined
        if (!vp) {
          throw new CommentUpdateError('viewpointGuid is not a viewpoint of this topic')
        }
        updatePayload.viewpointGuid = vp.guid
      }
    }
    const updatedComment = await deps.updateComment(comment.id, updatePayload)

    await deps.emitEvent({
      eventName: CommentEvents.Updated,
      payload: {
        previousComment: comment,
        newComment: updatedComment!,
        userId
      }
    })

    return updatedComment
  }

export const deleteCommentAndNotifyFactory =
  (deps: {
    getComment: GetComment
    deleteComment: (params: { commentId: string }) => Promise<boolean>
    markCommentUpdated: MarkCommentUpdated
    emitEvent: EventBusEmit
  }): DeleteCommentAndNotify =>
  async (input, userId) => {
    const comment = await deps.getComment({ id: input.commentId, userId })
    if (!comment || comment.streamId !== input.projectId) {
      throw new CommentNotFoundError('Comment not found')
    }
    if (!comment.parentComment) {
      throw new CommentUpdateError('Use topicMutations.delete to delete a topic')
    }
    const deleted = await deps.deleteComment({ commentId: comment.id })
    if (deleted) {
      await deps.markCommentUpdated(comment.parentComment)
      await deps.emitEvent({
        eventName: CommentEvents.Deleted,
        payload: { comment, userId }
      })
    }
    return deleted
  }
