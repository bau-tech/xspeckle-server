/**
 * The sync's view of one side (this server or the BCF server): topics with
 * their comments and viewpoints, each reduced to the content that is synced.
 *
 * `state` is what change detection compares. It is normalised so that the
 * same content read from either side compares equal where the formats allow
 * (labels sorted, empty strings as null, ...). Where they do not (rich-text
 * descriptions), each side is compared only with its own state from the last
 * sync, which link rows keep per side.
 */
import type { BcfBimSnippet, BcfViewpointData } from '@/modules/comments/helpers/types'

export interface TopicState {
  title: string
  description: string
  topicType: string | null
  topicStatus: string | null
  priority: string | null
  stage: string | null
  labels: string[]
  dueDate: string | null
  assignedTo: string | null
  referenceLinks: string[]
  bimSnippet: BcfBimSnippet | null
  relatedTopicGuids: string[]
  documentReferences: Array<{
    url: string | null
    documentGuid: string | null
    description: string | null
  }>
}

export interface CommentState {
  text: string
  viewpointGuid: string | null
}

export interface ItemMeta {
  creationDate: string | null
  creationAuthor: string | null
  modifiedDate: string | null
  modifiedAuthor: string | null
}

export interface SideViewpoint {
  guid: string
  index: number | null
  bcf: BcfViewpointData
  /** Loaded only where it may need copying to the other side. */
  snapshot: { type: 'png' | 'jpg'; data: Uint8Array } | null
}

export interface SideComment {
  guid: string
  state: CommentState
  meta: ItemMeta
  /** This server's comment id (local side only). */
  id?: string
}

export interface SideTopic {
  guid: string
  state: TopicState
  meta: ItemMeta
  comments: SideComment[]
  viewpoints: SideViewpoint[]
  /** This server's topic id (local side only). */
  id?: string
}

export type SyncItemKind = 'topic' | 'comment' | 'viewpoint'

export interface SyncLink {
  kind: SyncItemKind
  guid: string
  /** Comments and viewpoints: their topic's guid. */
  topicGuid: string | null
  localState: unknown
  remoteState: unknown
}

export type SyncAction =
  | 'create-local'
  | 'create-remote'
  | 'update-local'
  | 'update-remote'
  | 'delete-local'
  | 'delete-remote'
  /** Same on both sides: only record the baseline. */
  | 'link'
  /** Gone on both sides, or no longer synced: forget the link. */
  | 'unlink'

export interface SyncOp {
  kind: SyncItemKind
  action: SyncAction
  guid: string
  topicGuid: string | null
  /** Both sides changed; the newer one won. */
  conflict?: boolean
  /** A delete answered by restoring the item, as the other side edited it. */
  restore?: boolean
}

// --- normalisation -------------------------------------------------------------

const VIEWPOINT_ONLY_COMMENT = '(viewpoint)'

const str = (v: string | null | undefined) => {
  const t = (v ?? '').trim()
  return t === '' ? null : t
}

const text = (v: string | null | undefined) =>
  (v ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim()

const isoDate = (v: string | Date | null | undefined) => {
  if (!v) return null
  const d = v instanceof Date ? v : new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

const sorted = (values: Array<string | null | undefined>) =>
  [...new Set(values.map(str).filter((v): v is string => !!v))].sort()

export const topicState = (t: {
  title: string | null
  description: string | null
  topicType: string | null
  topicStatus: string | null
  priority: string | null
  stage: string | null
  labels: string[] | null
  dueDate: string | Date | null
  assignedTo: string | null
  referenceLinks: string[] | null
  bimSnippet: BcfBimSnippet | null
  relatedTopicGuids: string[]
  documentReferences: Array<{
    url: string | null
    documentGuid: string | null
    description: string | null
  }>
}): TopicState => ({
  title: text(t.title),
  description: text(t.description),
  topicType: str(t.topicType),
  topicStatus: str(t.topicStatus),
  priority: str(t.priority),
  stage: str(t.stage),
  labels: sorted(t.labels || []),
  dueDate: isoDate(t.dueDate),
  assignedTo: str(t.assignedTo),
  referenceLinks: sorted(t.referenceLinks || []),
  bimSnippet: t.bimSnippet
    ? {
        snippet_type: t.bimSnippet.snippet_type || '',
        is_external: !!t.bimSnippet.is_external,
        reference: t.bimSnippet.reference,
        reference_schema: t.bimSnippet.reference_schema || ''
      }
    : null,
  relatedTopicGuids: sorted(t.relatedTopicGuids.map((g) => g.toLowerCase())),
  documentReferences: t.documentReferences
    .map((d) => ({
      url: str(d.url),
      documentGuid: str(d.documentGuid)?.toLowerCase() ?? null,
      description: str(d.description)
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
})

export const commentState = (c: {
  text: string | null
  viewpointGuid: string | null
}): CommentState => {
  const t = text(c.text)
  return {
    // This server needs comment text, so a viewpoint-only BCF comment is
    // stored with a placeholder; both mean "no text".
    text: t === VIEWPOINT_ONLY_COMMENT ? '' : t,
    viewpointGuid: str(c.viewpointGuid)?.toLowerCase() ?? null
  }
}

export const meta = (m: {
  creationDate?: string | Date | null
  creationAuthor?: string | null
  modifiedDate?: string | Date | null
  modifiedAuthor?: string | null
}): ItemMeta => ({
  creationDate: isoDate(m.creationDate),
  creationAuthor: str(m.creationAuthor),
  modifiedDate: isoDate(m.modifiedDate),
  modifiedAuthor: str(m.modifiedAuthor)
})

/** Order-independent deep equality of plain JSON values. */
export const sameState = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object')
    return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    const bb = b as unknown[]
    return a.length === bb.length && a.every((v, i) => sameState(v, bb[i]))
  }
  const ao = a as Record<string, unknown>
  const bo = b as Record<string, unknown>
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)])
  for (const k of keys) {
    if (!sameState(ao[k] ?? null, bo[k] ?? null)) return false
  }
  return true
}

/** When an item was last changed on its side (modified, else created). */
export const changedAt = (m: ItemMeta) =>
  new Date(m.modifiedDate || m.creationDate || 0).getTime()

export { VIEWPOINT_ONLY_COMMENT }
