/**
 * Decides what a sync does, without doing it. The rules (the same as the
 * other BCF sync implementations in use, so behaviour does not change with
 * who syncs):
 *
 * - Change detection: each side is compared with its own state at the last
 *   sync (kept on the link). A side "changed" when they differ.
 * - Only one side changed: copy it over. Both: the newer one wins (modified,
 *   else creation date; a tie goes to the BCF server) and it counts as a
 *   conflict. Both changed to the same content: just record it.
 * - Linked but missing on one side: deleted there, so delete it on the other
 *   side too -- unless the other side changed it since, then it is restored.
 * - Never linked: present on one side only -> create it on the other; on
 *   both (same guid) -> pair them, the newer one winning if they differ.
 * - Viewpoints are immutable in BCF: created or deleted, never updated.
 * - The direction limits what is written: a pull-only connection never
 *   writes to the BCF server, a push-only one never writes here.
 *
 * A topic created on one side brings all its viewpoints and comments; a
 * topic deleted takes them along.
 */
import {
  changedAt,
  sameState,
  type SideComment,
  type SideTopic,
  type SyncItemKind,
  type SyncLink,
  type SyncOp
} from '@/modules/bcfsync/domain/sync'

export interface PlanOptions {
  allowPull: boolean
  allowPush: boolean
}

type Item = { guid: string; state?: unknown; meta?: SideComment['meta'] }

const key = (kind: SyncItemKind, guid: string) => `${kind}:${guid.toLowerCase()}`

/** The decision for one mutable item (topic or comment). */
const decide = (
  l: Item | undefined,
  r: Item | undefined,
  link: SyncLink | undefined,
  opts: PlanOptions
): Pick<SyncOp, 'action' | 'conflict' | 'restore'> | null => {
  const { allowPull, allowPush } = opts
  const remoteWins = (a: Item, b: Item) => changedAt(b.meta!) >= changedAt(a.meta!)

  if (l && r) {
    const same = sameState(l.state, r.state)
    if (!link) {
      if (same) return { action: 'link' }
      if (remoteWins(l, r)) return allowPull ? { action: 'update-local' } : { action: 'link' }
      return allowPush ? { action: 'update-remote' } : { action: 'link' }
    }
    const lc = !sameState(l.state, link.localState)
    const rc = !sameState(r.state, link.remoteState)
    if (!lc && !rc) return null
    if (same) return { action: 'link' }
    if (rc && !lc) return allowPull ? { action: 'update-local' } : null
    if (lc && !rc) return allowPush ? { action: 'update-remote' } : null
    if (remoteWins(l, r)) {
      if (allowPull) return { action: 'update-local', conflict: true }
      return allowPush ? { action: 'update-remote', conflict: true } : null
    }
    if (allowPush) return { action: 'update-remote', conflict: true }
    return allowPull ? { action: 'update-local', conflict: true } : null
  }

  if (l) {
    if (!link) return allowPush ? { action: 'create-remote' } : null
    // Deleted on the BCF server.
    const lc = !sameState(l.state, link.localState)
    if (lc && allowPush) return { action: 'create-remote', restore: true }
    if (allowPull) return { action: 'delete-local' }
    return allowPush ? { action: 'create-remote', restore: true } : { action: 'unlink' }
  }

  if (r) {
    if (!link) return allowPull ? { action: 'create-local' } : null
    // Deleted here.
    const rc = !sameState(r.state, link.remoteState)
    if (rc && allowPull) return { action: 'create-local', restore: true }
    if (allowPush) return { action: 'delete-remote' }
    return allowPull ? { action: 'create-local', restore: true } : { action: 'unlink' }
  }

  return link ? { action: 'unlink' } : null
}

/** Viewpoints: immutable, so only existence matters. */
const decideViewpoint = (
  l: boolean,
  r: boolean,
  link: boolean,
  opts: PlanOptions
): Pick<SyncOp, 'action'> | null => {
  if (l && r) return link ? null : { action: 'link' }
  if (l) {
    if (!link) return opts.allowPush ? { action: 'create-remote' } : null
    if (opts.allowPull) return { action: 'delete-local' }
    return opts.allowPush ? { action: 'create-remote' } : { action: 'unlink' }
  }
  if (r) {
    if (!link) return opts.allowPull ? { action: 'create-local' } : null
    if (opts.allowPush) return { action: 'delete-remote' }
    return opts.allowPull ? { action: 'create-local' } : { action: 'unlink' }
  }
  return link ? { action: 'unlink' } : null
}

const byGuid = <T extends { guid: string }>(items: T[]) =>
  new Map(items.map((i) => [i.guid.toLowerCase(), i]))

export const planSync = (params: {
  local: SideTopic[]
  remote: SideTopic[]
  links: SyncLink[]
  options: PlanOptions
}): SyncOp[] => {
  const { options } = params
  const local = byGuid(params.local)
  const remote = byGuid(params.remote)
  const links = new Map(params.links.map((l) => [key(l.kind, l.guid), l]))
  const childLinks = (kind: SyncItemKind, topicGuid: string) =>
    params.links.filter(
      (l) => l.kind === kind && l.topicGuid?.toLowerCase() === topicGuid
    )
  const ops: SyncOp[] = []

  const topicGuids = new Set([
    ...local.keys(),
    ...remote.keys(),
    ...params.links.filter((l) => l.kind === 'topic').map((l) => l.guid.toLowerCase())
  ])

  for (const guid of [...topicGuids].sort()) {
    const l = local.get(guid)
    const r = remote.get(guid)
    const link = links.get(key('topic', guid))
    const d = decide(l, r, link, options)
    if (d) ops.push({ kind: 'topic', guid, topicGuid: null, ...d })

    const action = d?.action
    // A topic that is created brings its children; one deleted (or no
    // longer synced) takes them along -- and their links.
    if (action === 'create-local' || action === 'create-remote') {
      const source = action === 'create-local' ? r! : l!
      for (const vp of source.viewpoints)
        ops.push({ kind: 'viewpoint', action, guid: vp.guid.toLowerCase(), topicGuid: guid })
      for (const c of source.comments)
        ops.push({ kind: 'comment', action, guid: c.guid.toLowerCase(), topicGuid: guid })
      continue
    }
    if (action === 'delete-local' || action === 'delete-remote' || action === 'unlink' || !l || !r) {
      for (const kind of ['viewpoint', 'comment'] as const)
        for (const cl of childLinks(kind, guid))
          ops.push({ kind, action: 'unlink', guid: cl.guid.toLowerCase(), topicGuid: guid })
      continue
    }

    // Both sides have the topic: their children are synced one by one.
    const lv = byGuid(l.viewpoints)
    const rv = byGuid(r.viewpoints)
    const vpGuids = new Set([
      ...lv.keys(),
      ...rv.keys(),
      ...childLinks('viewpoint', guid).map((x) => x.guid.toLowerCase())
    ])
    for (const vg of [...vpGuids].sort()) {
      const vd = decideViewpoint(
        lv.has(vg),
        rv.has(vg),
        links.has(key('viewpoint', vg)),
        options
      )
      if (vd) ops.push({ kind: 'viewpoint', guid: vg, topicGuid: guid, ...vd })
    }

    const lc = byGuid(l.comments)
    const rc = byGuid(r.comments)
    const commentGuids = new Set([
      ...lc.keys(),
      ...rc.keys(),
      ...childLinks('comment', guid).map((x) => x.guid.toLowerCase())
    ])
    for (const cg of [...commentGuids].sort()) {
      const cd = decide(lc.get(cg), rc.get(cg), links.get(key('comment', cg)), options)
      if (cd) ops.push({ kind: 'comment', guid: cg, topicGuid: guid, ...cd })
    }
  }
  return ops
}

export interface SyncSummary {
  [kindAction: string]: number
}

/** Counts per "kind action", e.g. { 'topic create-local': 2 }; plus conflicts. */
export const summarize = (ops: SyncOp[]) => {
  const counts: SyncSummary = {}
  let conflicts = 0
  for (const op of ops) {
    if (op.action === 'link' || op.action === 'unlink') continue
    const k = `${op.kind} ${op.action}`
    counts[k] = (counts[k] || 0) + 1
    if (op.conflict) conflicts++
  }
  return { counts, conflicts }
}

/**
 * Deleting most of what was synced usually means one side was read wrong
 * (wrong project, a permission change), not that people deleted it all.
 */
export const isMassDelete = (ops: SyncOp[], links: SyncLink[]) => {
  const linkedTopics = links.filter((l) => l.kind === 'topic').length
  const deletes = ops.filter(
    (o) => o.kind === 'topic' && (o.action === 'delete-local' || o.action === 'delete-remote')
  ).length
  return deletes > 5 && deletes > linkedTopics / 2
}
