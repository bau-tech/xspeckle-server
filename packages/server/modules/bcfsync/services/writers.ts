/* eslint-disable camelcase -- BCF's own snake_case wire format */
import type { Knex } from 'knex'
import { convertBasicStringToDocument } from '@/modules/core/services/richTextEditorService'
import { snapshotDataUri, viewpointInput } from '@/modules/comments/services/bcfTransfer'
import type {
  CreateCommentReplyAndNotify,
  CreateCommentThreadAndNotify,
  CreateViewpoint,
  DeleteCommentAndNotify,
  DeleteViewpoint,
  EditCommentAndNotify,
  EditTopicAndNotify
} from '@/modules/comments/domain/operations'
import type { CommentRecord } from '@/modules/comments/helpers/types'
import { Comments, TopicViewpoints } from '@/modules/core/dbSchema'
import type { BcfClient } from '@/modules/bcfsync/clients/bcf/client'
import { archiveComment, archiveTopic } from '@/modules/bcfsync/services/remoteTopics'
import { remoteSideTopic } from '@/modules/bcfsync/services/sides'
import {
  commentState,
  VIEWPOINT_ONLY_COMMENT,
  type SideComment,
  type SideTopic,
  type SideViewpoint,
  type TopicState
} from '@/modules/bcfsync/domain/sync'
import type { LocalWriter, RemoteWriter } from '@/modules/bcfsync/services/engine'
import {
  fitToExtensions,
  type BcfExtensionLists
} from '@/modules/bcfsync/services/extensions'

const doc = (text: string) =>
  text.trim() ? convertBasicStringToDocument(text) : { type: 'doc', content: [] }
const date = (iso: string | null) => (iso ? new Date(iso) : null)
const snippetInput = (s: TopicState['bimSnippet']) =>
  s
    ? {
        snippetType: s.snippet_type,
        isExternal: s.is_external,
        reference: s.reference,
        referenceSchema: s.reference_schema
      }
    : null

// --- this server ---------------------------------------------------------------

export const localWriterFactory = (deps: {
  projectId: string
  modelId: string
  userId: string
  actorIdentity?: string
  db: Knex
  createTopic: CreateCommentThreadAndNotify
  editTopic: EditTopicAndNotify
  deleteTopic: (topicId: string) => Promise<void>
  createViewpoint: CreateViewpoint
  deleteViewpoint: DeleteViewpoint
  createComment: CreateCommentReplyAndNotify
  editComment: EditCommentAndNotify
  deleteComment: DeleteCommentAndNotify
}): LocalWriter => {
  const { projectId, userId } = deps
  const options = deps.actorIdentity ? { actorIdentity: deps.actorIdentity } : undefined
  const fields = (t: SideTopic) => ({
    content: { doc: doc(t.state.description) },
    title: t.state.title,
    topicType: t.state.topicType,
    topicStatus: t.state.topicStatus,
    priority: t.state.priority,
    stage: t.state.stage,
    labels: t.state.labels,
    dueDate: date(t.state.dueDate),
    assignedTo: t.state.assignedTo,
    referenceLinks: t.state.referenceLinks,
    bimSnippet: snippetInput(t.state.bimSnippet),
    documentReferences: t.state.documentReferences.map((d) => ({ guid: null, ...d }))
  })
  const modified = (t: { meta: SideTopic['meta'] }) => ({
    modifiedAuthor: t.meta.modifiedAuthor ?? t.meta.creationAuthor,
    modifiedDate: date(t.meta.modifiedDate ?? t.meta.creationDate)
  })
  const commentDoc = (c: SideComment) => ({
    doc: convertBasicStringToDocument(c.state.text || VIEWPOINT_ONLY_COMMENT)
  })

  return {
    async createTopic(t) {
      const row: CommentRecord = await deps.createTopic(
        {
          projectId,
          // New topics are attached to the connected model.
          resourceIdString: deps.modelId,
          guid: t.guid,
          ...fields(t),
          creationAuthor: t.meta.creationAuthor,
          creationDate: date(t.meta.creationDate),
          modifiedAuthor: t.meta.modifiedAuthor,
          modifiedDate: date(t.meta.modifiedDate),
          viewpoint: null,
          screenshot: null
        },
        userId,
        options
      )
      return { id: row.id, guid: row.guid }
    },
    async updateTopic(id, t) {
      await deps.editTopic({ projectId, topicId: id, ...fields(t), ...modified(t) }, userId, options)
    },
    async deleteTopic(id) {
      await deps.deleteTopic(id)
    },
    async setRelatedTopics(id, source, guids) {
      await deps.editTopic(
        { projectId, topicId: id, relatedTopicGuids: guids, ...modified(source) },
        userId,
        options
      )
    },
    async createViewpoint(topicId, vp) {
      await deps.createViewpoint(
        {
          projectId,
          topicId,
          viewpoint: viewpointInput(vp, vp.guid),
          screenshot: snapshotDataUri(vp)
        },
        userId
      )
    },
    async deleteViewpoint(topicId, guid) {
      await deps.deleteViewpoint({ projectId, topicId, viewpointGuid: guid }, userId)
    },
    async createComment(topicId, c) {
      await deps.createComment(
        {
          projectId,
          topicId,
          guid: c.guid,
          content: commentDoc(c),
          viewpointGuid: c.state.viewpointGuid,
          creationAuthor: c.meta.creationAuthor,
          creationDate: date(c.meta.creationDate),
          modifiedAuthor: c.meta.modifiedAuthor,
          modifiedDate: date(c.meta.modifiedDate)
        },
        userId,
        options
      )
    },
    async updateComment(id, c) {
      await deps.editComment(
        {
          projectId,
          commentId: id,
          content: commentDoc(c),
          viewpointGuid: c.state.viewpointGuid,
          ...modified(c)
        },
        userId,
        options
      )
    },
    async deleteComment(id) {
      await deps.deleteComment({ projectId, commentId: id }, userId)
    },
    // Re-keying is bookkeeping, not an edit: no event, no modified date.
    async rekeyTopic(id, guid) {
      await deps.db(Comments.name).where({ id }).update({ guid })
    },
    async rekeyComment(id, guid) {
      await deps.db(Comments.name).where({ id }).update({ guid })
    },
    async rekeyViewpoint(topicId, from, to) {
      await deps.db.transaction(async (trx) => {
        await trx(TopicViewpoints.name).where({ topicId, guid: from }).update({ guid: to })
        await trx(Comments.name)
          .where({ parentComment: topicId, viewpointGuid: from })
          .update({ viewpointGuid: to })
      })
    }
  }
}

// --- BCF server ----------------------------------------------------------------

type WireDocRef = { url: string | null; document_guid: string | null; description: string | null }

const wireDocRef = (d: TopicState['documentReferences'][number]): WireDocRef => ({
  url: d.url,
  document_guid: d.documentGuid,
  description: d.description
})

const sameDocRef = (a: WireDocRef, b: WireDocRef) =>
  a.url === b.url && a.document_guid === b.document_guid && a.description === b.description

export const remoteWriterFactory = (deps: {
  client: BcfClient
  remoteProjectId: string
  extensions?: BcfExtensionLists
  warn?: (message: string) => void
}): RemoteWriter => {
  const { client, remoteProjectId: pid } = deps
  const lists = deps.extensions || {}
  const warn = deps.warn || (() => undefined)

  const topicBody = (t: SideTopic, current?: SideTopic) => {
    const s = fitToExtensions(t, lists, current, warn)
    return {
      title: s.title || 'Untitled',
      description: s.description,
      topic_type: s.topicType,
      topic_status: s.topicStatus,
      priority: s.priority,
      stage: s.stage,
      labels: s.labels,
      due_date: s.dueDate,
      assigned_to: s.assignedTo,
      reference_links: s.referenceLinks,
      bim_snippet: s.bimSnippet
    }
  }

  /** Adds the local document references the server lacks; it cannot remove any. */
  const pushDocRefs = async (
    topicGuid: string,
    local: TopicState['documentReferences'],
    remote: TopicState['documentReferences']
  ) => {
    const have = remote.map(wireDocRef)
    for (const d of local.map(wireDocRef)) {
      if (have.some((h) => sameDocRef(h, d))) continue
      await client.addDocumentReference(pid, topicGuid, d)
      have.push(d)
    }
    return have
  }

  /** The server's answer as sync state; falls back to what was sent. */
  const stateFrom = (
    resp: unknown,
    sent: SideTopic,
    docRefs: WireDocRef[]
  ): TopicState => {
    if (!resp || typeof resp !== 'object' || typeof (resp as { guid?: unknown }).guid !== 'string')
      return sent.state
    return remoteSideTopic(
      archiveTopic(resp as { guid: string }, {
        comments: [],
        viewpoints: [],
        relatedTopicGuids: sent.state.relatedTopicGuids,
        documentReferences: docRefs
      })
    ).state
  }

  return {
    async createTopic(t) {
      const resp = await client.createTopic(pid, {
        guid: t.guid,
        ...topicBody(t),
        creation_author: t.meta.creationAuthor,
        creation_date: t.meta.creationDate
      })
      const guid = (typeof resp?.guid === 'string' ? resp.guid : t.guid).toLowerCase()
      const docRefs = await pushDocRefs(guid, t.state.documentReferences, [])
      return { guid, state: stateFrom(resp, t, docRefs) }
    },
    async updateTopic(t, remote) {
      const resp = await client.updateTopic(pid, t.guid, {
        ...topicBody(t, remote),
        modified_author: t.meta.modifiedAuthor ?? t.meta.creationAuthor
      })
      const docRefs = await pushDocRefs(
        t.guid,
        t.state.documentReferences,
        remote.state.documentReferences
      )
      return { state: stateFrom(resp, t, docRefs) }
    },
    async deleteTopic(guid) {
      await client.deleteTopic(pid, guid)
    },
    async setRelatedTopics(topicGuid, guids) {
      await client.putRelatedTopics(pid, topicGuid, guids)
    },
    async createViewpoint(topicGuid, vp: SideViewpoint) {
      const resp = await client.createViewpoint(pid, topicGuid, {
        guid: vp.guid,
        index: vp.index,
        perspective_camera: vp.bcf.perspective_camera ?? null,
        orthogonal_camera: vp.bcf.orthogonal_camera ?? null,
        lines: vp.bcf.lines,
        clipping_planes: vp.bcf.clipping_planes,
        components: vp.bcf.components,
        snapshot: vp.snapshot
          ? {
              snapshot_type: vp.snapshot.type,
              snapshot_data: Buffer.from(vp.snapshot.data).toString('base64')
            }
          : null
      })
      return { guid: (typeof resp?.guid === 'string' ? resp.guid : vp.guid).toLowerCase() }
    },
    async deleteViewpoint(topicGuid, guid) {
      await client.deleteViewpoint(pid, topicGuid, guid)
    },
    async createComment(topicGuid, c) {
      const resp = await client.createComment(pid, topicGuid, {
        comment: c.state.text,
        viewpoint_guid: c.state.viewpointGuid,
        author: c.meta.creationAuthor,
        date: c.meta.creationDate
      })
      const ok = typeof resp?.guid === 'string'
      return {
        // BCF 3.0 has the server assign comment guids.
        guid: (ok ? resp.guid : c.guid).toLowerCase(),
        state: ok ? commentState(archiveComment(resp)) : c.state
      }
    },
    async updateComment(topicGuid, c) {
      const resp = await client.updateComment(pid, topicGuid, c.guid, {
        comment: c.state.text,
        viewpoint_guid: c.state.viewpointGuid,
        modified_author: c.meta.modifiedAuthor ?? c.meta.creationAuthor
      })
      return {
        state: typeof resp?.guid === 'string' ? commentState(archiveComment(resp)) : c.state
      }
    },
    async deleteComment(topicGuid, guid) {
      await client.deleteComment(pid, topicGuid, guid)
    }
  }
}
