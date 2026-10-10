import type { CommentRecord } from '@/modules/comments/helpers/types'
import {
  CommentDocumentReferences,
  Comments,
  TopicViewpoints
} from '@/modules/core/dbSchema'
import type { Knex } from 'knex'

/** A topic's comments (BCF Comment rows), oldest first. */
export const getTopicRepliesFactory =
  (deps: { db: Knex }) =>
  async (topicId: string): Promise<CommentRecord[]> =>
    await deps
      .db<CommentRecord>(Comments.name)
      .where(Comments.col.parentComment, topicId)
      .orderBy(Comments.col.createdAt, 'asc')

/** id -> BCF guid for the given topics. */
export const getTopicGuidsByIdsFactory =
  (deps: { db: Knex }) =>
  async (ids: string[]): Promise<Record<string, string>> => {
    if (!ids.length) return {}
    const rows = await deps
      .db<CommentRecord>(Comments.name)
      .select<Array<Pick<CommentRecord, 'id' | 'guid'>>>(Comments.col.id, Comments.col.guid)
      .whereIn(Comments.col.id, ids)
    return Object.fromEntries(rows.map((r) => [r.id, r.guid]))
  }

export type BcfGuidKind = 'comment' | 'viewpoint' | 'documentReference'

/**
 * BCF guids are unique across the whole region database, not per project --
 * an archive imported into a second project collides with the first.
 */
export const isBcfGuidTakenFactory =
  (deps: { db: Knex }) =>
  async (kind: BcfGuidKind, guid: string): Promise<boolean> => {
    const table =
      kind === 'comment'
        ? Comments
        : kind === 'viewpoint'
        ? TopicViewpoints
        : CommentDocumentReferences
    const row = await deps.db(table.name).select(1).where({ guid }).first()
    return !!row
  }
