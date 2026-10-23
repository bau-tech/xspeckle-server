/**
 * Carries out a sync plan (see planner.ts) and records the new baselines.
 *
 * Order: topics, then their viewpoints (comments refer to them), then
 * comments, then deletions (children first), then related topics (they may
 * point at topics created in this run). An item that fails is reported and
 * its link left as it was, so the next run tries again; a topic that could
 * not be created skips its children.
 */
import { ensureError } from '@speckle/shared'
import type {
  SideComment,
  SideTopic,
  SideViewpoint,
  SyncItemKind,
  SyncLink,
  SyncOp
} from '@/modules/bcfsync/domain/sync'

export interface LocalWriter {
  createTopic(t: SideTopic): Promise<{ id: string; guid: string }>
  updateTopic(id: string, t: SideTopic): Promise<void>
  deleteTopic(id: string): Promise<void>
  setRelatedTopics(id: string, t: SideTopic, guids: string[]): Promise<void>
  createViewpoint(topicId: string, vp: SideViewpoint): Promise<void>
  deleteViewpoint(topicId: string, guid: string): Promise<void>
  createComment(topicId: string, c: SideComment): Promise<void>
  updateComment(commentId: string, c: SideComment): Promise<void>
  deleteComment(commentId: string): Promise<void>
  /** After the BCF server assigned its own guid to something pushed. */
  rekeyTopic(id: string, guid: string): Promise<void>
  rekeyComment(id: string, guid: string): Promise<void>
  rekeyViewpoint(topicId: string, from: string, to: string): Promise<void>
}

export interface RemoteWriter {
  /** Each returns the item's state as the server now has it, and its guid. */
  createTopic(t: SideTopic): Promise<{ guid: string; state: unknown }>
  updateTopic(t: SideTopic, remote: SideTopic): Promise<{ state: unknown }>
  deleteTopic(guid: string): Promise<void>
  setRelatedTopics(topicGuid: string, guids: string[]): Promise<void>
  createViewpoint(topicGuid: string, vp: SideViewpoint): Promise<{ guid: string }>
  deleteViewpoint(topicGuid: string, guid: string): Promise<void>
  createComment(topicGuid: string, c: SideComment): Promise<{ guid: string; state: unknown }>
  updateComment(topicGuid: string, c: SideComment): Promise<{ state: unknown }>
  deleteComment(topicGuid: string, guid: string): Promise<void>
}

export interface SyncRunResult {
  applied: number
  failed: Array<{ kind: SyncItemKind; action: string; guid: string; error: string }>
}

const isCreate = (op: SyncOp) => op.action === 'create-local' || op.action === 'create-remote'
const isDelete = (op: SyncOp) => op.action === 'delete-local' || op.action === 'delete-remote'

export const executeSync = async (params: {
  ops: SyncOp[]
  local: SideTopic[]
  remote: SideTopic[]
  localWriter: LocalWriter
  remoteWriter: RemoteWriter
  /** Fresh read of this side after writing, for the new baselines. */
  readLocal: () => Promise<SideTopic[]>
  saveLinks: (links: SyncLink[]) => Promise<void>
  deleteLinks: (keys: Array<{ kind: SyncItemKind; guid: string }>) => Promise<void>
}): Promise<SyncRunResult> => {
  const { ops, localWriter: lw, remoteWriter: rw } = params
  const result: SyncRunResult = { applied: 0, failed: [] }

  const localTopics = new Map(params.local.map((t) => [t.guid, t]))
  const remoteTopics = new Map(params.remote.map((t) => [t.guid, t]))
  const findChild = <K extends 'comments' | 'viewpoints'>(
    topics: Map<string, SideTopic>,
    topicGuid: string,
    kind: K,
    guid: string
  ) => topics.get(topicGuid)?.[kind].find((x) => x.guid === guid) as SideTopic[K][number]

  /** This server's topic id by guid, including topics created in this run. */
  const topicIds = new Map<string, string>()
  for (const t of params.local) if (t.id) topicIds.set(t.guid, t.id)

  /** guid renames by the BCF server: original -> server's */
  const renamed = new Map<string, string>()
  const failedTopics = new Set<string>()
  /** Items whose links are rewritten at the end, and the remote state to keep. */
  const touched = new Map<string, { op: SyncOp; remoteState?: unknown }>()
  const k = (kind: SyncItemKind, guid: string) => `${kind}:${guid}`

  const attempt = async (op: SyncOp, fn: () => Promise<unknown | void>) => {
    if (op.topicGuid && failedTopics.has(op.topicGuid)) return
    try {
      const remoteState = await fn()
      result.applied++
      touched.set(k(op.kind, renamed.get(op.guid) ?? op.guid), {
        op,
        remoteState: remoteState ?? undefined
      })
    } catch (e) {
      result.failed.push({
        kind: op.kind,
        action: op.action,
        guid: op.guid,
        error: ensureError(e).message
      })
      if (op.kind === 'topic' && isCreate(op)) failedTopics.add(op.guid)
    }
  }

  const topicGuidOf = (op: SyncOp) => renamed.get(op.topicGuid!) ?? op.topicGuid!

  // 1. topics
  for (const op of ops.filter((o) => o.kind === 'topic' && !isDelete(o))) {
    const l = localTopics.get(op.guid)
    const r = remoteTopics.get(op.guid)
    await attempt(op, async () => {
      switch (op.action) {
        case 'create-local': {
          const created = await lw.createTopic(r!)
          topicIds.set(op.guid, created.id)
          return
        }
        case 'update-local':
          return await lw.updateTopic(l!.id!, r!)
        case 'create-remote': {
          const created = await rw.createTopic(l!)
          if (created.guid !== op.guid) {
            await lw.rekeyTopic(l!.id!, created.guid)
            renamed.set(op.guid, created.guid)
            topicIds.set(created.guid, l!.id!)
          }
          return created.state
        }
        case 'update-remote':
          return (await rw.updateTopic(l!, r!)).state
      }
    })
  }

  // 2. viewpoints, 3. comments
  for (const kind of ['viewpoint', 'comment'] as const) {
    for (const op of ops.filter((o) => o.kind === kind && !isDelete(o))) {
      await attempt(op, async () => {
        const topicGuid = topicGuidOf(op)
        const topicId = topicIds.get(topicGuid) ?? topicIds.get(op.topicGuid!)
        if (kind === 'viewpoint') {
          if (op.action === 'create-local') {
            const vp = findChild(remoteTopics, op.topicGuid!, 'viewpoints', op.guid)
            await lw.createViewpoint(topicId!, vp)
          } else if (op.action === 'create-remote') {
            const vp = findChild(localTopics, op.topicGuid!, 'viewpoints', op.guid)
            const created = await rw.createViewpoint(topicGuid, vp)
            if (created.guid !== op.guid) {
              await lw.rekeyViewpoint(topicId!, op.guid, created.guid)
              renamed.set(op.guid, created.guid)
            }
          }
          return
        }
        const l = findChild(localTopics, op.topicGuid!, 'comments', op.guid)
        const r = findChild(remoteTopics, op.topicGuid!, 'comments', op.guid)
        // A comment's viewpoint may have been renamed by the server just now.
        const withViewpoint = (c: SideComment): SideComment =>
          c.state.viewpointGuid && renamed.has(c.state.viewpointGuid)
            ? { ...c, state: { ...c.state, viewpointGuid: renamed.get(c.state.viewpointGuid)! } }
            : c
        switch (op.action) {
          case 'create-local':
            return await lw.createComment(topicId!, r)
          case 'update-local':
            return await lw.updateComment(l.id!, r)
          case 'create-remote': {
            const created = await rw.createComment(topicGuid, withViewpoint(l))
            if (created.guid !== op.guid) {
              await lw.rekeyComment(l.id!, created.guid)
              renamed.set(op.guid, created.guid)
            }
            return created.state
          }
          case 'update-remote':
            return (await rw.updateComment(topicGuid, withViewpoint(l))).state
        }
      })
    }
  }

  // 4. deletions, children first
  for (const kind of ['comment', 'viewpoint', 'topic'] as const) {
    for (const op of ops.filter((o) => o.kind === kind && isDelete(o))) {
      await attempt(op, async () => {
        const local = op.action === 'delete-local'
        if (kind === 'topic') {
          if (local) await lw.deleteTopic(localTopics.get(op.guid)!.id!)
          else await rw.deleteTopic(op.guid)
        } else if (kind === 'viewpoint') {
          if (local) await lw.deleteViewpoint(topicIds.get(op.topicGuid!)!, op.guid)
          else await rw.deleteViewpoint(op.topicGuid!, op.guid)
        } else {
          if (local)
            await lw.deleteComment(findChild(localTopics, op.topicGuid!, 'comments', op.guid).id!)
          else await rw.deleteComment(op.topicGuid!, op.guid)
        }
      })
    }
  }

  // 5. related topics of every topic written, now that all topics exist
  const topicsAfter = new Set([...topicIds.keys(), ...remoteTopics.keys(), ...renamed.values()])
  for (const op of ops.filter(
    (o) => o.kind === 'topic' && !isDelete(o) && o.action !== 'link' && o.action !== 'unlink'
  )) {
    if (!touched.has(k('topic', renamed.get(op.guid) ?? op.guid))) continue
    const toLocal = op.action === 'create-local' || op.action === 'update-local'
    const source = toLocal ? remoteTopics.get(op.guid)! : localTopics.get(op.guid)!
    const guids = source.state.relatedTopicGuids
      .map((g) => renamed.get(g) ?? g)
      .filter((g) => topicsAfter.has(g))
    const target = toLocal ? localTopics.get(op.guid) : remoteTopics.get(op.guid)
    const current = target?.state.relatedTopicGuids ?? []
    if (op.action.startsWith('create') && !guids.length) continue
    if (
      current.length === guids.length &&
      [...guids].sort().every((g, i) => [...current].sort()[i] === g)
    )
      continue
    try {
      if (toLocal) await lw.setRelatedTopics(topicIds.get(op.guid)!, source, guids)
      else await rw.setRelatedTopics(renamed.get(op.guid) ?? op.guid, guids)
    } catch (e) {
      result.failed.push({
        kind: 'topic',
        action: 'related-topics',
        guid: op.guid,
        error: ensureError(e).message
      })
    }
  }

  // 6. baselines
  const fresh = await params.readLocal()
  const freshTopics = new Map(fresh.map((t) => [t.guid, t]))
  const freshChild = (kind: SyncItemKind, topicGuid: string, guid: string) => {
    const t = freshTopics.get(topicGuid)
    if (!t) return undefined
    return kind === 'comment'
      ? t.comments.find((c) => c.guid === guid)
      : t.viewpoints.find((v) => v.guid === guid)
  }
  const remoteItem = (kind: SyncItemKind, topicGuid: string | null, guid: string) =>
    kind === 'topic'
      ? remoteTopics.get(guid)
      : kind === 'comment'
      ? findChild(remoteTopics, topicGuid!, 'comments', guid)
      : findChild(remoteTopics, topicGuid!, 'viewpoints', guid)

  const save: SyncLink[] = []
  const drop: Array<{ kind: SyncItemKind; guid: string }> = []
  for (const op of ops) {
    const guid = renamed.get(op.guid) ?? op.guid
    const topicGuid = op.topicGuid ? renamed.get(op.topicGuid) ?? op.topicGuid : null
    const done = touched.get(k(op.kind, guid))
    if (op.action === 'unlink') {
      if (!op.topicGuid || !failedTopics.has(op.topicGuid)) drop.push({ kind: op.kind, guid: op.guid })
      continue
    }
    if (!done) continue
    if (isDelete(op)) {
      drop.push({ kind: op.kind, guid: op.guid })
      continue
    }
    if (guid !== op.guid) drop.push({ kind: op.kind, guid: op.guid })
    const localNow =
      op.kind === 'topic' ? freshTopics.get(guid) : freshChild(op.kind, topicGuid!, guid)
    if (!localNow) continue
    const remoteBefore = remoteItem(op.kind, op.topicGuid, op.guid)
    const stateOf = (x: unknown) =>
      x && typeof x === 'object' && 'state' in x ? (x as { state: unknown }).state : null
    save.push({
      kind: op.kind,
      guid,
      topicGuid,
      localState: stateOf(localNow),
      // What the server answered when written to; else what was read from it.
      remoteState:
        done.remoteState !== undefined
          ? done.remoteState
          : op.action.endsWith('-local') || op.action === 'link'
          ? stateOf(remoteBefore) ?? stateOf(localNow)
          : stateOf(localNow)
    })
  }
  if (drop.length) await params.deleteLinks(drop)
  if (save.length) await params.saveLinks(save)
  return result
}
