import { expect } from 'chai'
import {
  commentState,
  meta,
  topicState,
  type SideComment,
  type SideTopic,
  type SyncLink
} from '@/modules/bcfsync/domain/sync'
import { isMassDelete, planSync, type PlanOptions } from '@/modules/bcfsync/services/planner'
import {
  executeSync,
  SyncSkip,
  type LocalWriter,
  type RemoteWriter
} from '@/modules/bcfsync/services/engine'

const vpData = () => ({
  lines: [],
  clipping_planes: [],
  components: {
    selection: [],
    coloring: [],
    visibility: { default_visibility: true, exceptions: [] }
  }
})
const g = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const clone = <T>(x: T): T => structuredClone(x)

let clock = Date.parse('2026-10-01T00:00:00Z')
const now = () => new Date((clock += 60_000)).toISOString()

const topic = (guid: string, title: string, over: Partial<SideTopic> = {}): SideTopic => ({
  guid,
  state: topicState({
    title,
    description: '',
    topicType: null,
    topicStatus: 'Open',
    priority: null,
    stage: null,
    labels: [],
    dueDate: null,
    assignedTo: null,
    referenceLinks: [],
    bimSnippet: null,
    relatedTopicGuids: [],
    documentReferences: []
  }),
  meta: meta({ creationDate: now(), creationAuthor: 'a@x.y' }),
  comments: [],
  viewpoints: [],
  ...over
})

const comment = (guid: string, text: string, viewpointGuid: string | null = null): SideComment => ({
  guid,
  state: commentState({ text, viewpointGuid }),
  meta: meta({ creationDate: now(), creationAuthor: 'a@x.y' })
})

/**
 * Two in-memory sides and the link store. The "server" assigns its own
 * comment guids, as BCF 3.0 does.
 */
const world = () => {
  const local = new Map<string, SideTopic>()
  const remote = new Map<string, SideTopic>()
  const links = new Map<string, SyncLink>()
  let ids = 0
  let serverGuid = 1000
  const failNext = new Set<string>()

  const byId = (id: string) => [...local.values()].find((t) => t.id === id)!
  const commentById = (id: string) => {
    for (const t of local.values()) {
      const c = t.comments.find((x) => x.id === id)
      if (c) return { t, c }
    }
    throw new Error('no comment ' + id)
  }
  const maybeFail = (what: string) => {
    if (failNext.delete(what)) throw new Error(`${what} failed`)
  }

  const localWriter: LocalWriter = {
    async createTopic(t) {
      maybeFail('createTopic-local')
      const id = `t${++ids}`
      local.set(t.guid, { ...clone(t), id, comments: [], viewpoints: [] })
      return { id, guid: t.guid }
    },
    async updateTopic(id, t) {
      const lt = byId(id)
      lt.state = { ...clone(t.state), relatedTopicGuids: lt.state.relatedTopicGuids }
      lt.meta = clone(t.meta)
    },
    async deleteTopic(id) {
      local.delete(byId(id).guid)
    },
    async setRelatedTopics(id, _s, guids) {
      byId(id).state.relatedTopicGuids = [...guids].sort()
    },
    async createViewpoint(topicId, vp) {
      byId(topicId).viewpoints.push(clone(vp))
    },
    async deleteViewpoint(topicId, guid) {
      const t = byId(topicId)
      t.viewpoints = t.viewpoints.filter((v) => v.guid !== guid)
    },
    async createComment(topicId, c) {
      byId(topicId).comments.push({ ...clone(c), id: `c${++ids}` })
    },
    async updateComment(id, c) {
      const { c: lc } = commentById(id)
      lc.state = clone(c.state)
      lc.meta = clone(c.meta)
    },
    async deleteComment(id) {
      const { t } = commentById(id)
      t.comments = t.comments.filter((c) => c.id !== id)
    },
    async rekeyTopic(id, guid) {
      const t = byId(id)
      local.delete(t.guid)
      t.guid = guid
      local.set(guid, t)
    },
    async rekeyComment(id, guid) {
      commentById(id).c.guid = guid
    },
    async rekeyViewpoint() {
      throw new Error('not expected')
    }
  }

  const strip = (t: SideTopic): SideTopic => {
    const { id: _id, ...rest } = clone(t)
    return { ...rest, comments: rest.comments.map(({ id: _cid, ...c }) => c) }
  }

  const remoteWriter: RemoteWriter = {
    async createTopic(t) {
      maybeFail('createTopic-remote')
      remote.set(t.guid, { ...strip(t), comments: [], viewpoints: [] })
      return { guid: t.guid, state: clone(t.state) }
    },
    async updateTopic(t) {
      const rt = remote.get(t.guid)!
      rt.state = { ...clone(t.state), relatedTopicGuids: rt.state.relatedTopicGuids }
      rt.meta = { ...clone(t.meta), modifiedDate: now() }
      return { state: clone(t.state) }
    },
    async deleteTopic(guid) {
      remote.delete(guid)
    },
    async setRelatedTopics(topicGuid, guids) {
      remote.get(topicGuid)!.state.relatedTopicGuids = [...guids].sort()
    },
    async createViewpoint(topicGuid, vp) {
      remote.get(topicGuid)!.viewpoints.push(clone(vp))
      return { guid: vp.guid }
    },
    async deleteViewpoint(topicGuid, guid) {
      const t = remote.get(topicGuid)!
      t.viewpoints = t.viewpoints.filter((v) => v.guid !== guid)
    },
    async createComment(topicGuid, c) {
      const guid = g(++serverGuid)
      remote.get(topicGuid)!.comments.push({ ...strip({ ...topic('x', 'x'), comments: [c] }).comments[0], guid })
      return { guid, state: clone(c.state) }
    },
    async updateComment(topicGuid, c) {
      const rc = remote.get(topicGuid)!.comments.find((x) => x.guid === c.guid)!
      rc.state = clone(c.state)
      return { state: clone(c.state) }
    },
    async deleteComment(topicGuid, guid) {
      const t = remote.get(topicGuid)!
      t.comments = t.comments.filter((c) => c.guid !== guid)
    }
  }

  const sync = async (options: PlanOptions = { allowPull: true, allowPush: true }) => {
    const l = [...local.values()].map(clone)
    const r = [...remote.values()].map(clone)
    const ls = [...links.values()]
    const ops = planSync({ local: l, remote: r, links: ls, options })
    const result = await executeSync({
      ops,
      local: l,
      remote: r,
      localWriter,
      remoteWriter,
      readLocal: async () => [...local.values()].map(clone),
      saveLinks: async (rows) => {
        for (const row of rows) links.set(`${row.kind}:${row.guid}`, clone(row))
      },
      deleteLinks: async (keys) => {
        for (const key of keys) links.delete(`${key.kind}:${key.guid}`)
      }
    })
    return { ops: ops.filter((o) => o.action !== 'link' && o.action !== 'unlink'), result }
  }

  return { local, remote, links, failNext, sync }
}

const actions = (ops: Array<{ kind: string; action: string }>) =>
  ops.map((o) => `${o.kind} ${o.action}`).sort()

describe('BCF sync engine', () => {
  it('pulls a new remote topic with its viewpoint and comment, then is idle', async () => {
    const w = world()
    w.remote.set(
      g(1),
      topic(g(1), 'Clash', {
        viewpoints: [{ guid: g(2), index: 1, bcf: vpData(), snapshot: null }],
        comments: [comment(g(3), 'look here', g(2))]
      })
    )
    const first = await w.sync()
    expect(actions(first.ops)).to.deep.equal([
      'comment create-local',
      'topic create-local',
      'viewpoint create-local'
    ])
    expect(w.local.get(g(1))!.comments[0].state.viewpointGuid).to.equal(g(2))
    expect((await w.sync()).ops).to.deep.equal([])
  })

  it('pushes a new local topic and adopts the server-assigned comment guid', async () => {
    const w = world()
    w.local.set(g(1), { ...topic(g(1), 'Mine', { comments: [{ ...comment(g(3), 'c'), id: 'c0' }] }), id: 't0' })
    await w.sync()
    const serverComment = w.remote.get(g(1))!.comments[0].guid
    expect(serverComment).to.not.equal(g(3))
    expect(w.local.get(g(1))!.comments[0].guid).to.equal(serverComment)
    expect((await w.sync()).ops).to.deep.equal([])
  })

  it('copies one-sided edits both ways', async () => {
    const w = world()
    w.remote.set(g(1), topic(g(1), 'A', { comments: [comment(g(3), 'x')] }))
    await w.sync()

    w.remote.get(g(1))!.state.title = 'A remote'
    w.remote.get(g(1))!.meta.modifiedDate = now()
    expect(actions((await w.sync()).ops)).to.deep.equal(['topic update-local'])
    expect(w.local.get(g(1))!.state.title).to.equal('A remote')

    w.local.get(g(1))!.comments[0].state.text = 'edited here'
    expect(actions((await w.sync()).ops)).to.deep.equal(['comment update-remote'])
    expect(w.remote.get(g(1))!.comments[0].state.text).to.equal('edited here')
    expect((await w.sync()).ops).to.deep.equal([])
  })

  it('resolves edits on both sides by date and reports the conflict', async () => {
    const w = world()
    w.remote.set(g(1), topic(g(1), 'A'))
    await w.sync()
    w.remote.get(g(1))!.state.title = 'remote'
    w.remote.get(g(1))!.meta.modifiedDate = now()
    w.local.get(g(1))!.state.title = 'local, later'
    w.local.get(g(1))!.meta.modifiedDate = now()
    const { ops } = await w.sync()
    expect(ops).to.deep.equal([
      { kind: 'topic', action: 'update-remote', guid: g(1), topicGuid: null, conflict: true }
    ])
    expect(w.remote.get(g(1))!.state.title).to.equal('local, later')
  })

  it('propagates deletes, but restores what the other side edited meanwhile', async () => {
    const w = world()
    w.remote.set(g(1), topic(g(1), 'gone soon', { comments: [comment(g(3), 'c')] }))
    w.remote.set(g(2), topic(g(2), 'kept'))
    await w.sync()

    w.remote.delete(g(1))
    expect(actions((await w.sync()).ops)).to.deep.equal(['topic delete-local'])
    expect(w.local.has(g(1))).to.equal(false)
    expect([...w.links.keys()].some((k) => k.includes(g(3)))).to.equal(false)

    w.local.delete(g(2))
    w.remote.get(g(2))!.state.title = 'edited remotely'
    expect((await w.sync()).ops[0]).to.include({ action: 'create-local', restore: true })
    expect(w.local.get(g(2))!.state.title).to.equal('edited remotely')
  })

  it('pull-only never writes to the server', async () => {
    const w = world()
    w.remote.set(g(1), topic(g(1), 'A'))
    const pull = { allowPull: true, allowPush: false }
    await w.sync(pull)
    w.local.set(g(5), { ...topic(g(5), 'local only'), id: 'tx' })
    w.local.get(g(1))!.state.title = 'local edit'
    expect((await w.sync(pull)).ops).to.deep.equal([])
    expect(w.remote.has(g(5))).to.equal(false)
    expect(w.remote.get(g(1))!.state.title).to.equal('A')
  })

  it('pairs identical topics found on both sides without writing', async () => {
    const w = world()
    const t = topic(g(1), 'same')
    w.remote.set(g(1), clone(t))
    w.local.set(g(1), { ...clone(t), id: 't1' })
    expect((await w.sync()).ops).to.deep.equal([])
    expect(w.links.has(`topic:${g(1)}`)).to.equal(true)
  })

  it('syncs related topics once both exist', async () => {
    const w = world()
    w.remote.set(g(1), topic(g(1), 'A'))
    const b = topic(g(2), 'B')
    b.state.relatedTopicGuids = [g(1)]
    w.remote.set(g(2), b)
    await w.sync()
    expect(w.local.get(g(2))!.state.relatedTopicGuids).to.deep.equal([g(1)])
    expect((await w.sync()).ops).to.deep.equal([])
  })

  it('retries what failed on the next run', async () => {
    const w = world()
    w.remote.set(g(1), topic(g(1), 'A', { comments: [comment(g(3), 'c')] }))
    w.failNext.add('createTopic-local')
    const first = await w.sync()
    expect(first.result.failed).to.have.length(1)
    expect(w.links.size).to.equal(0) // children skipped, nothing recorded
    await w.sync()
    expect(w.local.get(g(1))!.comments).to.have.length(1)
  })

  it('flags plans that delete most synced topics', () => {
    const links: SyncLink[] = Array.from({ length: 10 }, (_, i) => ({
      kind: 'topic',
      guid: g(i),
      topicGuid: null,
      localState: null,
      remoteState: null
    }))
    const ops = links
      .slice(0, 6)
      .map((l) => ({ kind: 'topic' as const, action: 'delete-local' as const, guid: l.guid, topicGuid: null }))
    expect(isMassDelete(ops, links)).to.equal(true)
    expect(isMassDelete(ops.slice(0, 5), links)).to.equal(false)
  })
})

describe('BCF sync engine, items the server has elsewhere', () => {
  it('reports them as skipped, not failed, and leaves their children alone', async () => {
    const local: SideTopic = { ...topic(g(1), 'elsewhere'), id: 't1', comments: [{ ...comment(g(2), 'c'), id: 'c1' }] }
    const created: string[] = []
    const result = await executeSync({
      ops: planSync({ local: [local], remote: [], links: [], options: { allowPull: true, allowPush: true } }),
      local: [local],
      remote: [],
      localWriter: {} as LocalWriter,
      remoteWriter: {
        createTopic: async () => {
          throw new SyncSkip('the BCF server already has this topic in another project')
        },
        createComment: async (_t: string, c: SideComment) => {
          created.push(c.guid)
          return { guid: c.guid, state: c.state }
        }
      } as unknown as RemoteWriter,
      readLocal: async () => [local],
      saveLinks: async () => undefined,
      deleteLinks: async () => undefined
    })
    expect(result.failed).to.deep.equal([])
    expect(result.skipped).to.deep.equal([
      { kind: 'topic', guid: g(1), reason: 'the BCF server already has this topic in another project' }
    ])
    expect(created).to.deep.equal([])
  })
})
