import { expect } from 'chai'
import {
  extensionLists,
  fitToExtensions,
  mergeExtensionLists
} from '@/modules/bcfsync/services/extensions'
import { meta, topicState, type SideTopic } from '@/modules/bcfsync/domain/sync'

const topic = (over: Partial<Parameters<typeof topicState>[0]> = {}): SideTopic => ({
  guid: 'g',
  state: topicState({
    title: 'T',
    description: '',
    topicType: 'Clash',
    topicStatus: 'open',
    priority: 'Urgent',
    stage: null,
    labels: ['Structure', 'Mine'],
    dueDate: null,
    assignedTo: 'a@x.y',
    referenceLinks: [],
    bimSnippet: null,
    relatedTopicGuids: [],
    documentReferences: [],
    ...over
  }),
  meta: meta({}),
  comments: [],
  viewpoints: []
})

describe('BCF sync extensions', () => {
  it("merges several connections' lists, each value once", () => {
    expect(
      mergeExtensionLists([
        { users: ['a@x.y', 'b@x.y'], topic_status: ['Open'] },
        null,
        { users: ['b@x.y', 'c@x.y'], priority: ['High'] }
      ])
    ).to.deep.equal({
      topic_status: ['Open'],
      priority: ['High'],
      users: ['a@x.y', 'b@x.y', 'c@x.y']
    })
    expect(mergeExtensionLists([])).to.deep.equal({})
  })

  it('keeps only non-empty string lists', () => {
    expect(
      extensionLists({
        topic_status: ['Open', 'Closed', 3],
        priority: [],
        users: ['a@x.y'],
        project_actions: ['update']
      })
    ).to.deep.equal({ topic_status: ['Open', 'Closed'], users: ['a@x.y'] })
  })

  it('sends everything as is when the server has no lists', () => {
    const t = topic()
    const warnings: string[] = []
    expect(fitToExtensions(t, {}, undefined, (m) => warnings.push(m))).to.deep.equal(t.state)
    expect(warnings).to.deep.equal([])
  })

  it("uses the server's spelling, keeps the current value or leaves it empty", () => {
    const lists = {
      topic_status: ['Open', 'Closed'],
      topic_type: ['Issue'],
      priority: ['Normal', 'High'],
      topic_label: ['Structure'],
      users: ['b@x.y']
    }
    const warnings: string[] = []
    const current = topic({ topicType: 'Issue', priority: 'High', assignedTo: 'b@x.y' })

    const updated = fitToExtensions(topic(), lists, current, (m) => warnings.push(m))
    expect(updated).to.deep.include({
      topicStatus: 'Open', // case only
      topicType: 'Issue', // kept
      priority: 'High', // kept
      assignedTo: 'b@x.y', // kept
      labels: ['Structure']
    })

    const created = fitToExtensions(topic(), lists, undefined, () => undefined)
    expect(created).to.deep.include({ topicType: null, priority: null, assignedTo: null })

    expect(warnings).to.have.length(4) // type, priority, assignee, label "Mine"
    expect(warnings.join(' ')).to.include('label "Mine"')
  })
})
