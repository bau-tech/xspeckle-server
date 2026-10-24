/**
 * Reads a remote BCF project into the same in-memory shape a BCF archive is
 * read into (BcfArchiveTopic), so pulling reuses the archive import: matched
 * on guids, events and notifications included.
 */
/* eslint-disable camelcase -- BCF's own snake_case wire format */
import type {
  BcfArchiveComment,
  BcfArchiveTopic,
  BcfArchiveViewpoint
} from '@/modules/comments/services/bcfArchive'
import type { BcfBimSnippet, BcfViewpointData } from '@/modules/comments/helpers/types'
import type {
  BcfClient,
  BcfWireComment,
  BcfWireTopic,
  BcfWireViewpoint
} from '@/modules/bcfsync/clients/bcf/client'

const TOPIC_CONCURRENCY = 4

const s = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null

type Vec = { x: number; y: number; z: number }
const vec = (v: unknown): Vec | null => {
  const o = obj(v)
  if (!o) return null
  const [x, y, z] = [o.x, o.y, o.z].map(Number)
  return [x, y, z].every(Number.isFinite) ? { x, y, z } : null
}

const camera = (v: unknown): BcfViewpointData['perspective_camera'] => {
  const o = obj(v)
  if (!o) return null
  const point = vec(o.camera_view_point)
  const direction = vec(o.camera_direction)
  const up = vec(o.camera_up_vector)
  if (!point || !direction || !up) return null
  return {
    camera_view_point: point,
    camera_direction: direction,
    camera_up_vector: up,
    ...(typeof o.field_of_view === 'number' ? { field_of_view: o.field_of_view } : {}),
    ...(typeof o.view_to_world_scale === 'number'
      ? { view_to_world_scale: o.view_to_world_scale }
      : {}),
    ...(typeof o.aspect_ratio === 'number' ? { aspect_ratio: o.aspect_ratio } : {})
  }
}

const component = (v: unknown) => {
  const o = obj(v) || {}
  return {
    ifc_guid: s(o.ifc_guid),
    originating_system: s(o.originating_system),
    authoring_tool_id: s(o.authoring_tool_id)
  }
}

/** BCF components from a viewpoint, filling what the server left out. */
export const viewpointData = (
  vp: BcfWireViewpoint,
  parts?: { selection?: unknown; coloring?: unknown; visibility?: unknown }
): BcfViewpointData => {
  const inline = obj(vp.components) || {}
  const selection = parts?.selection ?? inline.selection
  const coloring = parts?.coloring ?? inline.coloring
  const visibility = obj(parts?.visibility ?? inline.visibility) || {}
  const hints = obj(visibility.view_setup_hints)
  return {
    perspective_camera: camera(vp.perspective_camera),
    orthogonal_camera: camera(vp.orthogonal_camera),
    lines: arr(vp.lines).flatMap((l) => {
      const start = vec(obj(l)?.start_point)
      const end = vec(obj(l)?.end_point)
      return start && end ? [{ start_point: start, end_point: end }] : []
    }),
    clipping_planes: arr(vp.clipping_planes).flatMap((p) => {
      const location = vec(obj(p)?.location)
      const direction = vec(obj(p)?.direction)
      return location && direction ? [{ location, direction }] : []
    }),
    components: {
      selection: arr(selection).map(component),
      coloring: arr(coloring).flatMap((c) => {
        const o = obj(c)
        return o && typeof o.color === 'string'
          ? [{ color: o.color, components: arr(o.components).map(component) }]
          : []
      }),
      visibility: {
        default_visibility: visibility.default_visibility !== false,
        exceptions: arr(visibility.exceptions).map(component),
        view_setup_hints: hints
          ? {
              spaces_visible: typeof hints.spaces_visible === 'boolean' ? hints.spaces_visible : null,
              space_boundaries_visible:
                typeof hints.space_boundaries_visible === 'boolean'
                  ? hints.space_boundaries_visible
                  : null,
              openings_visible:
                typeof hints.openings_visible === 'boolean' ? hints.openings_visible : null
            }
          : null
      }
    }
  }
}

const bimSnippet = (v: unknown): BcfBimSnippet | null => {
  const o = obj(v)
  if (!o || typeof o.reference !== 'string') return null
  return {
    snippet_type: s(o.snippet_type) || '',
    is_external: o.is_external === true,
    reference: o.reference,
    reference_schema: s(o.reference_schema) || ''
  }
}

export const archiveComment = (c: BcfWireComment): BcfArchiveComment => ({
  guid: c.guid,
  date: s(c.date),
  author: s(c.author),
  text: typeof c.comment === 'string' ? c.comment : '',
  viewpointGuid: s(c.viewpoint_guid),
  modifiedDate: s(c.modified_date),
  modifiedAuthor: s(c.modified_author)
})

export const archiveTopic = (
  t: BcfWireTopic,
  rest: {
    comments: BcfArchiveComment[]
    viewpoints: BcfArchiveViewpoint[]
    relatedTopicGuids: string[]
    documentReferences: Array<Record<string, unknown>>
  }
): BcfArchiveTopic => ({
  guid: t.guid,
  topicType: s(t.topic_type),
  topicStatus: s(t.topic_status),
  serverAssignedId: s(t.server_assigned_id),
  title: s(t.title) || 'Untitled',
  priority: s(t.priority),
  index: null,
  labels: strings(t.labels),
  referenceLinks: strings(t.reference_links),
  creationDate: s(t.creation_date),
  creationAuthor: s(t.creation_author),
  modifiedDate: s(t.modified_date),
  modifiedAuthor: s(t.modified_author),
  dueDate: s(t.due_date),
  assignedTo: s(t.assigned_to),
  stage: s(t.stage),
  description: typeof t.description === 'string' ? t.description : '',
  bimSnippet: bimSnippet(t.bim_snippet),
  documentReferences: rest.documentReferences.map((d) => ({
    guid: s(d.guid),
    documentGuid: s(d.document_guid),
    url: s(d.url),
    description: s(d.description)
  })),
  relatedTopicGuids: rest.relatedTopicGuids,
  comments: rest.comments,
  viewpoints: rest.viewpoints
})

/** Runs `fn` over `items`, at most `limit` at a time, keeping order. */
const mapLimit = async <T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>) => {
  const out = new Array<R>(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i])
      }
    })
  )
  return out
}

/**
 * Every topic of a remote project with its comments, viewpoints, relations and
 * document references. Viewpoints are immutable in BCF, so the components and
 * snapshot of one we already have (`haveViewpoint`) are not downloaded again.
 */
export const fetchRemoteTopics = async (args: {
  client: BcfClient
  remoteProjectId: string
  haveViewpoint: (guid: string) => Promise<boolean>
}): Promise<BcfArchiveTopic[]> => {
  const { client, remoteProjectId: pid } = args
  const topics = await client.listAllTopics(pid)
  return await mapLimit(topics, TOPIC_CONCURRENCY, async (t) => {
    const [comments, viewpoints, relatedTopicGuids, documentReferences] = await Promise.all([
      client.listComments(pid, t.guid),
      client.listViewpoints(pid, t.guid),
      client.listRelatedTopicGuids(pid, t.guid),
      client.listDocumentReferences(pid, t.guid)
    ])
    const archiveViewpoints: BcfArchiveViewpoint[] = []
    for (const vp of viewpoints) {
      const known = await args.haveViewpoint(vp.guid.toLowerCase())
      const parts =
        known || obj(vp.components)
          ? undefined
          : await client.getViewpointComponents(pid, t.guid, vp.guid)
      archiveViewpoints.push({
        guid: vp.guid,
        index: typeof vp.index === 'number' ? vp.index : null,
        bcf: viewpointData(vp, parts),
        // a server that does not say (no `snapshot` key) is asked anyway
        snapshot:
          known || vp.snapshot === null
            ? null
            : await client.getSnapshot(pid, t.guid, vp.guid)
      })
    }
    return archiveTopic(t, {
      comments: comments.map(archiveComment),
      viewpoints: archiveViewpoints,
      relatedTopicGuids,
      documentReferences
    })
  })
}
