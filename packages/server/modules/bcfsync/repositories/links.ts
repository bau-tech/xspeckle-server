import { buildTableHelper } from '@/modules/core/dbSchema'
import type { SyncItemKind, SyncLink } from '@/modules/bcfsync/domain/sync'
import type { Knex } from 'knex'

export const BcfSyncLinks = buildTableHelper('bcf_sync_links', [
  'connectionId',
  'kind',
  'guid',
  'topicGuid',
  'localState',
  'remoteState',
  'syncedAt'
])

type Row = SyncLink & { connectionId: string; syncedAt: Date }

const tbl = (db: Knex) => db<Row>(BcfSyncLinks.name)

export const getBcfSyncLinksFactory =
  (deps: { db: Knex }) =>
  async (connectionId: string): Promise<SyncLink[]> =>
    (await tbl(deps.db).where({ connectionId })).map(
      ({ kind, guid, topicGuid, localState, remoteState }) => ({
        kind,
        guid,
        topicGuid,
        localState,
        remoteState
      })
    )

export const saveBcfSyncLinksFactory =
  (deps: { db: Knex }) =>
  async (connectionId: string, links: SyncLink[]) => {
    if (!links.length) return
    const now = new Date()
    await tbl(deps.db)
      .insert(
        links.map((l) => ({
          connectionId,
          kind: l.kind,
          guid: l.guid,
          topicGuid: l.topicGuid,
          // jsonb: stored as given, null for viewpoints (existence only)
          localState: JSON.stringify(l.localState ?? null) as unknown,
          remoteState: JSON.stringify(l.remoteState ?? null) as unknown,
          syncedAt: now
        }))
      )
      .onConflict(['connectionId', 'kind', 'guid'])
      .merge(['topicGuid', 'localState', 'remoteState', 'syncedAt'])
  }

export const deleteBcfSyncLinksFactory =
  (deps: { db: Knex }) =>
  async (connectionId: string, keys: Array<{ kind: SyncItemKind; guid: string }>) => {
    if (!keys.length) return
    await tbl(deps.db)
      .where({ connectionId })
      .andWhere((q) => {
        for (const k of keys) q.orWhere({ kind: k.kind, guid: k.guid })
      })
      .delete()
  }
