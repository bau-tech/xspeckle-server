/* eslint-disable camelcase */
import { expect } from 'chai'
import {
  archiveComment,
  archiveTopic,
  fetchRemoteTopics,
  viewpointData
} from '@/modules/bcfsync/services/remoteTopics'
import type { BcfClient } from '@/modules/bcfsync/clients/bcf/client'

const g = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const v = (x: number, y: number, z: number) => ({ x, y, z })

const empty = { comments: [], viewpoints: [], relatedTopicGuids: [], documentReferences: [] }

describe('BCF sync remote topics', () => {
  describe('wire mapping', () => {
    it('maps a topic and drops malformed values', () => {
      const t = archiveTopic(
        {
          guid: g(1),
          title: 'Wall clash',
          topic_status: 'Open',
          labels: ['Structure', 7],
          due_date: null,
          description: 'desc',
          bim_snippet: { reference: 'x.ifc', is_external: true },
          reference_links: ['https://a']
        },
        {
          comments: [],
          viewpoints: [],
          relatedTopicGuids: [g(2)],
          documentReferences: [{ guid: g(3), url: 'https://doc', description: null }]
        }
      )
      expect(t).to.deep.include({
        guid: g(1),
        title: 'Wall clash',
        topicStatus: 'Open',
        labels: ['Structure'],
        dueDate: null,
        description: 'desc',
        referenceLinks: ['https://a'],
        relatedTopicGuids: [g(2)]
      })
      expect(t.bimSnippet).to.deep.equal({
        snippet_type: '',
        is_external: true,
        reference: 'x.ifc',
        reference_schema: ''
      })
      expect(t.documentReferences).to.deep.equal([
        { guid: g(3), documentGuid: null, url: 'https://doc', description: null }
      ])
      expect(archiveTopic({ guid: g(1) }, empty).title).to.equal('Untitled')
    })

    it('maps a comment', () => {
      expect(
        archiveComment({ guid: g(5), comment: 'hi', author: 'a@b.c', viewpoint_guid: g(6) })
      ).to.deep.equal({
        guid: g(5),
        date: null,
        author: 'a@b.c',
        text: 'hi',
        viewpointGuid: g(6),
        modifiedDate: null,
        modifiedAuthor: null
      })
    })

    it('prefers component sub-resources and fills defaults', () => {
      const cam = {
        camera_view_point: v(1, 2, 3),
        camera_direction: v(0, 1, 0),
        camera_up_vector: v(0, 0, 1),
        field_of_view: 60
      }
      const vp = viewpointData(
        { guid: g(7), perspective_camera: cam, lines: [{ start_point: v(0, 0, 0) }] },
        {
          selection: [{ ifc_guid: 'abc' }],
          visibility: { default_visibility: false, exceptions: [{ ifc_guid: 'x' }] }
        }
      )
      expect(vp.perspective_camera).to.deep.equal(cam)
      expect(vp.orthogonal_camera).to.equal(null)
      expect(vp.lines).to.deep.equal([]) // incomplete line dropped
      expect(vp.components.selection).to.deep.equal([
        { ifc_guid: 'abc', originating_system: null, authoring_tool_id: null }
      ])
      expect(vp.components.visibility.default_visibility).to.equal(false)
      expect(vp.components.coloring).to.deep.equal([])
      // nothing at all -> visible by default
      expect(viewpointData({ guid: g(8) }).components.visibility.default_visibility).to.equal(true)
    })

    it('does not download what a known viewpoint already has', async () => {
      const calls: string[] = []
      const client = {
        listAllTopics: async () => [{ guid: g(1), title: 'T' }],
        listComments: async () => [],
        listViewpoints: async () => [
          { guid: g(10), snapshot: { snapshot_type: 'png' } },
          { guid: g(11), snapshot: { snapshot_type: 'png' } },
          { guid: g(12), snapshot: null }
        ],
        listRelatedTopicGuids: async () => [],
        listDocumentReferences: async () => [],
        getViewpointComponents: async (_p: string, _t: string, vp: string) => {
          calls.push(`components ${vp}`)
          return { selection: [] }
        },
        getSnapshot: async (_p: string, _t: string, vp: string) => {
          calls.push(`snapshot ${vp}`)
          return { type: 'png', data: new Uint8Array([1]) }
        }
      } as unknown as BcfClient
      const [t] = await fetchRemoteTopics({
        client,
        remoteProjectId: 'p',
        haveViewpoint: async (guid) => guid === g(10)
      })
      expect(calls).to.deep.equal([
        `components ${g(11)}`,
        `snapshot ${g(11)}`,
        `components ${g(12)}`
      ])
      expect(t.viewpoints.map((x) => !!x.snapshot)).to.deep.equal([false, true, false])
    })
  })
})
