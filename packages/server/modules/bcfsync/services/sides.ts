/**
 * Reads each side of a connection into the sync's common shape (SideTopic).
 */
import type { BcfArchiveTopic } from '@/modules/comments/services/bcfArchive'
import type {
  CommentDocumentReferenceRecord,
  CommentRecord,
  CommentRelatedTopicRecord,
  TopicViewpointRecord
} from '@/modules/comments/helpers/types'
import { documentToBasicString } from '@/modules/core/services/richTextEditorService'
import { ensureCommentSchema } from '@/modules/comments/services/commentTextService'
import { formatSerializedViewerState } from '@/modules/comments/services/data'
import {
  bcfViewpointFromState,
  emptyBcfViewpoint
} from '@/modules/comments/services/bcfViewpoint'
import {
  commentState,
  meta,
  topicState,
  type SideTopic,
  type SideViewpoint
} from '@/modules/bcfsync/domain/sync'

// --- BCF server ----------------------------------------------------------------

export const remoteSideTopic = (t: BcfArchiveTopic): SideTopic => ({
  guid: t.guid.toLowerCase(),
  state: topicState({
    title: t.title,
    description: t.description,
    topicType: t.topicType,
    topicStatus: t.topicStatus,
    priority: t.priority,
    stage: t.stage,
    labels: t.labels,
    dueDate: t.dueDate,
    assignedTo: t.assignedTo,
    referenceLinks: t.referenceLinks,
    bimSnippet: t.bimSnippet,
    relatedTopicGuids: t.relatedTopicGuids,
    documentReferences: t.documentReferences
  }),
  meta: meta({
    creationDate: t.creationDate,
    creationAuthor: t.creationAuthor,
    modifiedDate: t.modifiedDate,
    modifiedAuthor: t.modifiedAuthor
  }),
  comments: t.comments.map((c) => ({
    guid: c.guid.toLowerCase(),
    state: commentState({ text: c.text, viewpointGuid: c.viewpointGuid }),
    meta: meta({
      creationDate: c.date,
      creationAuthor: c.author,
      modifiedDate: c.modifiedDate,
      modifiedAuthor: c.modifiedAuthor
    })
  })),
  viewpoints: t.viewpoints.map((v) => ({
    guid: v.guid.toLowerCase(),
    index: v.index,
    bcf: v.bcf,
    snapshot: v.snapshot
  }))
})

// --- this server ---------------------------------------------------------------

export const recordText = (text: CommentRecord['text']) =>
  text ? documentToBasicString(ensureCommentSchema(text).doc) : ''

export const localViewpoint = (row: TopicViewpointRecord): SideViewpoint => {
  const state = row.data?.state ? formatSerializedViewerState(row.data.state) : null
  const snapshot = row.screenshot
    ? Buffer.from(row.screenshot.replace(/^data:image\/[a-z]+;base64,/i, ''), 'base64')
    : null
  return {
    guid: row.guid.toLowerCase(),
    index: row.index,
    bcf: row.bcf || (state ? bcfViewpointFromState(state) : emptyBcfViewpoint()),
    snapshot:
      snapshot && snapshot.length
        ? { type: row.snapshotType === 'jpg' ? 'jpg' : 'png', data: new Uint8Array(snapshot) }
        : null
  }
}

export const readLocalSideFactory =
  (deps: {
    /** The model's topics (every version). */
    getModelTopics: () => Promise<CommentRecord[]>
    getTopicReplies: (topicId: string) => Promise<CommentRecord[]>
    getTopicViewpoints: (topicId: string) => Promise<TopicViewpointRecord[]>
    getCommentRelatedTopics: (topicId: string) => Promise<CommentRelatedTopicRecord[]>
    getTopicGuidsByIds: (ids: string[]) => Promise<Record<string, string>>
    getCommentDocumentReferences: (topicId: string) => Promise<CommentDocumentReferenceRecord[]>
    /** BCF identity (email) of a user, for rows without creationAuthor. */
    getIdentity: (userId: string) => Promise<string | null>
  }) =>
  async (): Promise<SideTopic[]> => {
    const identities = new Map<string, Promise<string | null>>()
    const author = (r: CommentRecord) => {
      if (r.creationAuthor) return Promise.resolve(r.creationAuthor)
      if (!identities.has(r.authorId)) identities.set(r.authorId, deps.getIdentity(r.authorId))
      return identities.get(r.authorId)!
    }

    const topics = await deps.getModelTopics()
    const result: SideTopic[] = []
    for (const t of topics) {
      const [replies, viewpoints, related, docRefs] = await Promise.all([
        deps.getTopicReplies(t.id),
        deps.getTopicViewpoints(t.id),
        deps.getCommentRelatedTopics(t.id),
        deps.getCommentDocumentReferences(t.id)
      ])
      const relatedGuids = await deps.getTopicGuidsByIds(related.map((r) => r.relatedTopicId))
      const comments = []
      for (const c of replies) {
        comments.push({
          id: c.id,
          guid: c.guid.toLowerCase(),
          state: commentState({ text: recordText(c.text), viewpointGuid: c.viewpointGuid }),
          meta: meta({
            creationDate: c.createdAt,
            creationAuthor: await author(c),
            modifiedDate: c.modifiedDate,
            modifiedAuthor: c.modifiedAuthor
          })
        })
      }
      result.push({
        id: t.id,
        guid: t.guid.toLowerCase(),
        state: topicState({
          title: t.title,
          description: recordText(t.text),
          topicType: t.topicType,
          topicStatus: t.topicStatus,
          priority: t.priority,
          stage: t.stage,
          labels: t.labels,
          dueDate: t.dueDate,
          assignedTo: t.assignedTo,
          referenceLinks: t.referenceLinks,
          bimSnippet: t.bimSnippet,
          relatedTopicGuids: Object.values(relatedGuids),
          documentReferences: docRefs
        }),
        meta: meta({
          creationDate: t.createdAt,
          creationAuthor: await author(t),
          modifiedDate: t.modifiedDate,
          modifiedAuthor: t.modifiedAuthor
        }),
        comments,
        viewpoints: viewpoints.map(localViewpoint)
      })
    }
    return result
  }
