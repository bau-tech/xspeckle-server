/**
 * BCF archive import/export on top of the topic/comment/viewpoint services:
 * an import goes through the same create/update paths as the GraphQL API
 * (events, notifications and subscriptions included), keyed on BCF guids so
 * re-importing an archive updates instead of duplicating.
 */
/* eslint-disable camelcase -- BcfViewpointData is BCF's own snake_case wire format */
import { randomUUID } from 'node:crypto'
import type {
  BcfArchive,
  BcfArchiveComment,
  BcfArchiveTopic,
  BcfArchiveViewpoint,
  BcfVersion
} from '@/modules/comments/services/bcfArchive'
import type {
  BcfComponent,
  BcfViewpointData,
  CommentDocumentReferenceRecord,
  CommentRecord,
  TopicViewpointRecord
} from '@/modules/comments/helpers/types'
import type {
  CreateCommentReplyAndNotify,
  CreateCommentThreadAndNotify,
  CreateViewpoint,
  DeleteCommentRelatedTopics,
  EditTopicAndNotify,
  GetCommentByGuid,
  GetCommentDocumentReferences,
  GetCommentRelatedTopics,
  GetTopicIdsByGuids,
  GetTopicViewpoints,
  InsertCommentRelatedTopics
} from '@/modules/comments/domain/operations'
import type { BcfGuidKind } from '@/modules/comments/repositories/bcfArchive'
import type { ViewpointInput } from '@/modules/core/graph/generated/graphql'
import {
  convertBasicStringToDocument,
  documentToBasicString
} from '@/modules/core/services/richTextEditorService'
import { ensureCommentSchema } from '@/modules/comments/services/commentTextService'
import { formatSerializedViewerState } from '@/modules/comments/services/data'
import {
  bcfViewpointFromState,
  emptyBcfViewpoint
} from '@/modules/comments/services/bcfViewpoint'
import { ensureError } from '@speckle/shared'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Text for a BCF comment that only carries a viewpoint (comment text is required here). */
const VIEWPOINT_ONLY_COMMENT = '(viewpoint)'

const validDate = (value: string | null): Date | null => {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}
/** BCF dates as the GraphQL DateTime inputs (Date objects) the services take. */
const iso = (value: string | null) => validDate(value)

const plainTextDoc = (text: string) =>
  text.trim() ? convertBasicStringToDocument(text) : { type: 'doc', content: [] }

const recordText = (text: CommentRecord['text']) =>
  text ? documentToBasicString(ensureCommentSchema(text).doc) : ''

// --- viewpoints --------------------------------------------------------------

const toVec = (v: { x: number; y: number; z: number }) => ({ x: v.x, y: v.y, z: v.z })
const componentInput = (c: BcfComponent) => ({
  ifcGuid: c.ifc_guid ?? null,
  originatingSystem: c.originating_system ?? null,
  authoringToolId: c.authoring_tool_id ?? null
})

/** Archive viewpoint -> the GraphQL ViewpointInput the create services take. */
const viewpointInput = (vp: BcfArchiveViewpoint, guid: string): ViewpointInput => {
  // Components are stored exactly as the file has them: the external BCF server's sync
  // copies stored viewpoints as-is, so anything rewritten here would surface
  // there as different data under the same viewpoint guid.
  const bcf = vp.bcf
  const cameraInput = (c: NonNullable<BcfViewpointData['perspective_camera']>) => ({
    cameraViewPoint: toVec(c.camera_view_point),
    cameraDirection: toVec(c.camera_direction),
    cameraUpVector: toVec(c.camera_up_vector),
    fieldOfView: c.field_of_view ?? null,
    viewToWorldScale: c.view_to_world_scale ?? null,
    aspectRatio: c.aspect_ratio ?? null
  })
  const hints = bcf.components.visibility.view_setup_hints
  return {
    guid,
    index: vp.index,
    perspectiveCamera: bcf.perspective_camera ? cameraInput(bcf.perspective_camera) : null,
    orthogonalCamera: bcf.orthogonal_camera ? cameraInput(bcf.orthogonal_camera) : null,
    lines: bcf.lines.map((l) => ({ startPoint: toVec(l.start_point), endPoint: toVec(l.end_point) })),
    clippingPlanes: bcf.clipping_planes.map((p) => ({
      location: toVec(p.location),
      direction: toVec(p.direction)
    })),
    components: {
      selection: bcf.components.selection.map(componentInput),
      coloring: bcf.components.coloring.map((g) => ({
        color: g.color,
        components: g.components.map(componentInput)
      })),
      visibility: {
        defaultVisibility: bcf.components.visibility.default_visibility,
        exceptions: bcf.components.visibility.exceptions.map(componentInput),
        viewSetupHints: hints
          ? {
              spacesVisible: hints.spaces_visible ?? null,
              spaceBoundariesVisible: hints.space_boundaries_visible ?? null,
              openingsVisible: hints.openings_visible ?? null
            }
          : null
      }
    },
    snapshotType: vp.snapshot?.type ?? null
  }
}

const snapshotDataUri = (vp: BcfArchiveViewpoint) =>
  vp.snapshot
    ? `data:image/${vp.snapshot.type === 'jpg' ? 'jpeg' : 'png'};base64,${Buffer.from(
        vp.snapshot.data
      ).toString('base64')}`
    : null

// --- import ------------------------------------------------------------------

export type BcfTopicImportStatus = 'created' | 'updated' | 'unchanged' | 'failed'

export interface BcfImportReport {
  version: string
  topicsCreated: number
  topicsUpdated: number
  topicsUnchanged: number
  topicsFailed: number
  commentsCreated: number
  viewpointsCreated: number
  topics: Array<{
    guid: string
    title: string
    status: BcfTopicImportStatus
    topicId?: string
    error?: string
  }>
  warnings: string[]
}

export const importBcfArchiveFactory =
  (deps: {
    createTopic: CreateCommentThreadAndNotify
    createComment: CreateCommentReplyAndNotify
    createViewpoint: CreateViewpoint
    editTopic: EditTopicAndNotify
    getCommentByGuid: GetCommentByGuid
    getTopicViewpoints: GetTopicViewpoints
    getCommentDocumentReferences: GetCommentDocumentReferences
    getTopicIdsByGuids: GetTopicIdsByGuids
    deleteCommentRelatedTopics: DeleteCommentRelatedTopics
    insertCommentRelatedTopics: InsertCommentRelatedTopics
    isBcfGuidTaken: (kind: BcfGuidKind, guid: string) => Promise<boolean>
  }) =>
  async (params: {
    projectId: string
    resourceIdString: string
    archive: BcfArchive
    userId: string
    actorIdentity?: string
  }): Promise<BcfImportReport> => {
    const { projectId, resourceIdString, archive, userId, actorIdentity } = params
    const report: BcfImportReport = {
      version: archive.version,
      topicsCreated: 0,
      topicsUpdated: 0,
      topicsUnchanged: 0,
      topicsFailed: 0,
      commentsCreated: 0,
      viewpointsCreated: 0,
      topics: [],
      warnings: []
    }
    const options = actorIdentity ? { actorIdentity } : undefined

    /** A guid this import may use: the file's own, unless taken elsewhere. */
    const claimGuid = async (kind: BcfGuidKind, guid: string | null) => {
      const normalized = guid && UUID_RE.test(guid) ? guid.toLowerCase() : null
      if (normalized && !(await deps.isBcfGuidTaken(kind, normalized))) return normalized
      return randomUUID()
    }

    /**
     * A topic's document references for create/update. A reference keeps its
     * stored guid when the file has none (a re-import must not re-key it: the
     * external BCF server's sync would see a change), and the file's guid unless another
     * topic already uses it.
     */
    const documentReferencesFor = async (topic: BcfArchiveTopic, topicId: string | null) => {
      const stored = topicId ? await deps.getCommentDocumentReferences(topicId) : []
      const result = []
      for (const d of topic.documentReferences) {
        const documentGuid = d.documentGuid && UUID_RE.test(d.documentGuid) ? d.documentGuid : null
        const fileGuid = d.guid && UUID_RE.test(d.guid) ? d.guid.toLowerCase() : null
        const sameGuid = fileGuid ? stored.find((r) => r.guid === fileGuid) : undefined
        const sameContent = stored.find(
          (r) =>
            r.url === d.url && r.documentGuid === documentGuid && r.description === d.description
        )
        let guid = sameGuid?.guid ?? null
        if (!guid && fileGuid && !(await deps.isBcfGuidTaken('documentReference', fileGuid))) {
          guid = fileGuid
        }
        if (!guid && !fileGuid) guid = sameContent?.guid ?? null
        result.push({ guid, documentGuid, url: d.url, description: d.description })
      }
      return result
    }

    // file topic guid -> the guid it was stored under (for related topics)
    const topicGuids = new Map<string, string>()
    const relationsToWrite: Array<{ topicId: string; related: string[] }> = []

    for (const topic of archive.topics) {
      try {
        const fileGuid = UUID_RE.test(topic.guid) ? topic.guid.toLowerCase() : null
        const existing = fileGuid
          ? await deps.getCommentByGuid({ streamId: projectId, guid: fileGuid })
          : undefined
        if (existing && existing.parentComment) {
          throw new Error('its guid belongs to a comment in this project, not a topic')
        }

        let topicRecord: CommentRecord
        let status: BcfTopicImportStatus
        let fieldsApplied = false
        const viewpointGuids = new Map<string, string>() // file guid -> stored guid
        const pendingViewpoints = [...topic.viewpoints].sort(
          (a, b) => (a.index ?? Infinity) - (b.index ?? Infinity)
        )

        if (existing) {
          topicRecord = existing
          for (const vp of await deps.getTopicViewpoints(existing.id)) {
            viewpointGuids.set(vp.guid, vp.guid)
          }
          // Only overwrite the topic when the file's version is newer.
          const fileModified =
            validDate(topic.modifiedDate) || validDate(topic.creationDate) || new Date(0)
          const storedModified = existing.modifiedDate || existing.createdAt
          if (fileModified > storedModified) {
            const updated = await deps.editTopic(
              {
                projectId,
                topicId: existing.id,
                content: { doc: plainTextDoc(topic.description) },
                title: topic.title,
                topicType: topic.topicType,
                topicStatus: topic.topicStatus,
                priority: topic.priority,
                stage: topic.stage,
                labels: topic.labels,
                dueDate: iso(topic.dueDate),
                assignedTo: topic.assignedTo,
                referenceLinks: topic.referenceLinks,
                bimSnippet: topic.bimSnippet
                  ? {
                      snippetType: topic.bimSnippet.snippet_type,
                      isExternal: topic.bimSnippet.is_external,
                      reference: topic.bimSnippet.reference,
                      referenceSchema: topic.bimSnippet.reference_schema
                    }
                  : null,
                documentReferences: await documentReferencesFor(topic, existing.id),
                modifiedAuthor: topic.modifiedAuthor ?? topic.creationAuthor,
                modifiedDate: fileModified
              },
              userId,
              options
            )
            topicRecord = updated || existing
            status = 'updated'
            fieldsApplied = true
          } else {
            status = 'unchanged'
          }
        } else {
          const guid = await claimGuid('comment', fileGuid)
          if (fileGuid && guid !== fileGuid) {
            report.warnings.push(
              `Topic "${topic.title}" exists in another project; imported under a new guid.`
            )
          }
          const first = pendingViewpoints.shift()
          const firstGuid = first ? await claimGuid('viewpoint', first.guid) : null
          if (first && firstGuid) viewpointGuids.set(first.guid.toLowerCase(), firstGuid)

          const documentReferences = await documentReferencesFor(topic, null)

          topicRecord = await deps.createTopic(
            {
              projectId,
              resourceIdString,
              guid,
              content: { doc: plainTextDoc(topic.description) },
              title: topic.title,
              topicType: topic.topicType,
              topicStatus: topic.topicStatus,
              priority: topic.priority,
              stage: topic.stage,
              labels: topic.labels,
              dueDate: iso(topic.dueDate),
              assignedTo: topic.assignedTo,
              referenceLinks: topic.referenceLinks,
              bimSnippet: topic.bimSnippet
                ? {
                    snippetType: topic.bimSnippet.snippet_type,
                    isExternal: topic.bimSnippet.is_external,
                    reference: topic.bimSnippet.reference,
                    referenceSchema: topic.bimSnippet.reference_schema
                  }
                : null,
              documentReferences,
              creationAuthor: topic.creationAuthor,
              creationDate: iso(topic.creationDate),
              modifiedAuthor: topic.modifiedAuthor,
              modifiedDate: iso(topic.modifiedDate),
              viewpoint: first && firstGuid ? viewpointInput(first, firstGuid) : null,
              screenshot: first ? snapshotDataUri(first) : null
            },
            userId,
            options
          )
          if (first) report.viewpointsCreated++
          status = 'created'
          fieldsApplied = true
        }
        topicGuids.set(topic.guid.toLowerCase(), topicRecord.guid)

        // Viewpoints the topic does not have yet.
        for (const vp of pendingViewpoints) {
          const key = vp.guid.toLowerCase()
          if (viewpointGuids.has(key)) continue
          const guid = await claimGuid('viewpoint', key)
          const row: TopicViewpointRecord = await deps.createViewpoint(
            {
              projectId,
              topicId: topicRecord.id,
              viewpoint: viewpointInput(vp, guid),
              screenshot: snapshotDataUri(vp)
            },
            userId
          )
          viewpointGuids.set(key, row.guid)
          report.viewpointsCreated++
          if (status === 'unchanged') status = 'updated'
        }

        // Comments the topic does not have yet, oldest first.
        const comments = [...topic.comments].sort(
          (a, b) =>
            (validDate(a.date)?.getTime() ?? 0) - (validDate(b.date)?.getTime() ?? 0)
        )
        for (const comment of comments) {
          const fileCommentGuid = UUID_RE.test(comment.guid) ? comment.guid.toLowerCase() : null
          if (
            fileCommentGuid &&
            (await deps.getCommentByGuid({ streamId: projectId, guid: fileCommentGuid }))
          ) {
            continue
          }
          const viewpointGuid = comment.viewpointGuid
            ? viewpointGuids.get(comment.viewpointGuid.toLowerCase()) ?? null
            : null
          if (!comment.text.trim() && !viewpointGuid) continue
          await deps.createComment(
            {
              projectId,
              topicId: topicRecord.id,
              guid: await claimGuid('comment', fileCommentGuid),
              content: {
                doc: convertBasicStringToDocument(comment.text.trim() || VIEWPOINT_ONLY_COMMENT)
              },
              viewpointGuid,
              creationAuthor: comment.author,
              creationDate: iso(comment.date),
              modifiedAuthor: comment.modifiedAuthor,
              modifiedDate: iso(comment.modifiedDate)
            },
            userId,
            options
          )
          report.commentsCreated++
          if (status === 'unchanged') status = 'updated'
        }

        // Only where the file's topic was applied: adding comments to a topic
        // must not replace relations edited since (the external BCF server's sync would
        // carry that over as an edit).
        if (fieldsApplied && (status !== 'created' || topic.relatedTopicGuids.length)) {
          relationsToWrite.push({ topicId: topicRecord.id, related: topic.relatedTopicGuids })
        }
        report.topics.push({ guid: topicRecord.guid, title: topic.title, status, topicId: topicRecord.id })
        if (status === 'created') report.topicsCreated++
        else if (status === 'updated') report.topicsUpdated++
        else report.topicsUnchanged++
      } catch (e) {
        report.topicsFailed++
        report.topics.push({
          guid: topic.guid,
          title: topic.title,
          status: 'failed',
          error: ensureError(e).message
        })
      }
    }

    // Related topics last: they may point at topics later in the archive.
    for (const { topicId, related } of relationsToWrite) {
      const guids = related
        .map((g) => topicGuids.get(g.toLowerCase()) ?? g.toLowerCase())
        .filter((g) => UUID_RE.test(g))
      const ids = await deps.getTopicIdsByGuids({ streamId: projectId, guids })
      await deps.deleteCommentRelatedTopics(topicId)
      await deps.insertCommentRelatedTopics(
        ids.map((relatedTopicId) => ({ topicId, relatedTopicId }))
      )
      if (ids.length < guids.length) {
        report.warnings.push(
          `${guids.length - ids.length} related topic(s) are not in this project and were skipped.`
        )
      }
    }

    return report
  }

// --- export ------------------------------------------------------------------

export const exportBcfTopicsFactory =
  (deps: {
    getTopicReplies: (topicId: string) => Promise<CommentRecord[]>
    getTopicViewpoints: GetTopicViewpoints
    getCommentRelatedTopics: GetCommentRelatedTopics
    getTopicGuidsByIds: (ids: string[]) => Promise<Record<string, string>>
    getCommentDocumentReferences: GetCommentDocumentReferences
    /** The BCF identity to write for a user: an email, or a name for outsiders. */
    getIdentity: (userId: string) => Promise<string | null>
  }) =>
  async (topics: CommentRecord[], version: BcfVersion): Promise<BcfArchiveTopic[]> => {
    const identities = new Map<string, Promise<string | null>>()
    const identity = (record: CommentRecord) => {
      if (record.creationAuthor) return Promise.resolve(record.creationAuthor)
      if (!identities.has(record.authorId)) {
        identities.set(record.authorId, deps.getIdentity(record.authorId))
      }
      return identities.get(record.authorId)!
    }

    const result: BcfArchiveTopic[] = []
    for (const topic of topics) {
      const [replies, viewpointRows, related, docRefs] = await Promise.all([
        deps.getTopicReplies(topic.id),
        deps.getTopicViewpoints(topic.id),
        deps.getCommentRelatedTopics(topic.id),
        deps.getCommentDocumentReferences(topic.id)
      ])
      const relatedGuids = await deps.getTopicGuidsByIds(related.map((r) => r.relatedTopicId))

      const viewpoints: BcfArchiveViewpoint[] = viewpointRows.map((row, i) => {
        const state = row.data?.state ? formatSerializedViewerState(row.data.state) : null
        const bcf = row.bcf || (state ? bcfViewpointFromState(state) : emptyBcfViewpoint())
        const snapshot = row.screenshot
          ? Buffer.from(row.screenshot.replace(/^data:image\/[a-z]+;base64,/i, ''), 'base64')
          : null
        const type = row.snapshotType === 'jpg' ? 'jpg' : 'png'
        return {
          guid: row.guid,
          index: row.index ?? i + 1,
          bcf,
          snapshot: snapshot && snapshot.length ? { type, data: new Uint8Array(snapshot) } : null
        }
      })

      const comments: BcfArchiveComment[] = []
      for (const reply of replies) {
        comments.push({
          guid: reply.guid,
          date: reply.createdAt.toISOString(),
          author: (await identity(reply)) || 'unknown',
          text: recordText(reply.text),
          viewpointGuid: reply.viewpointGuid,
          modifiedDate: reply.modifiedDate?.toISOString() ?? null,
          modifiedAuthor: reply.modifiedAuthor
        })
      }

      const description = recordText(topic.text)
      result.push({
        guid: topic.guid,
        topicType: topic.topicType,
        topicStatus: topic.topicStatus,
        serverAssignedId: topic.index ? String(topic.index) : null,
        title: topic.title || description.split('\n')[0].slice(0, 80) || `Topic ${topic.index ?? ''}`.trim(),
        priority: topic.priority,
        index: version === '2.1' ? topic.index : null,
        labels: topic.labels || [],
        referenceLinks: topic.referenceLinks || [],
        creationDate: topic.createdAt.toISOString(),
        creationAuthor: (await identity(topic)) || 'unknown',
        modifiedDate: topic.modifiedDate?.toISOString() ?? null,
        modifiedAuthor: topic.modifiedAuthor,
        dueDate: topic.dueDate?.toISOString() ?? null,
        assignedTo: topic.assignedTo,
        stage: topic.stage,
        description,
        bimSnippet: topic.bimSnippet,
        documentReferences: docRefs.map((d: CommentDocumentReferenceRecord) => ({
          guid: d.guid ?? null,
          documentGuid: d.documentGuid,
          url: d.url,
          description: d.description
        })),
        relatedTopicGuids: Object.values(relatedGuids),
        comments,
        viewpoints
      })
    }
    return result
  }
