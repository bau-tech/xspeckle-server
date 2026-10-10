/**
 * BCF archive (.bcf / .bcfzip) reading and writing -- the file format only,
 * no database access. Reads BCF 2.0, 2.1 and 3.0; writes 2.1 or 3.0.
 *
 * Viewpoints are kept in the same snake_case BCF wire shape the topic
 * viewpoints are stored in (BcfViewpointData), so an archive maps onto
 * topics/comments/viewpoints without another intermediate model.
 */
/* eslint-disable camelcase -- BcfViewpointData is BCF's own snake_case wire format */
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { XMLParser } from 'fast-xml-parser'
import type {
  BcfBimSnippet,
  BcfCamera,
  BcfComponent,
  BcfViewpointData
} from '@/modules/comments/helpers/types'
import { emptyBcfViewpoint } from '@/modules/comments/services/bcfViewpoint'

export type BcfVersion = '2.1' | '3.0'

export interface BcfArchiveViewpoint {
  guid: string
  index: number | null
  bcf: BcfViewpointData
  snapshot: { type: 'png' | 'jpg'; data: Uint8Array } | null
}

export interface BcfArchiveComment {
  guid: string
  date: string | null
  author: string | null
  text: string
  viewpointGuid: string | null
  modifiedDate: string | null
  modifiedAuthor: string | null
}

export interface BcfArchiveDocumentReference {
  guid: string | null
  documentGuid: string | null
  url: string | null
  description: string | null
}

export interface BcfArchiveTopic {
  guid: string
  topicType: string | null
  topicStatus: string | null
  serverAssignedId: string | null
  title: string
  priority: string | null
  index: number | null
  labels: string[]
  referenceLinks: string[]
  creationDate: string | null
  creationAuthor: string | null
  modifiedDate: string | null
  modifiedAuthor: string | null
  dueDate: string | null
  assignedTo: string | null
  stage: string | null
  description: string
  bimSnippet: BcfBimSnippet | null
  documentReferences: BcfArchiveDocumentReference[]
  relatedTopicGuids: string[]
  comments: BcfArchiveComment[]
  viewpoints: BcfArchiveViewpoint[]
}

export interface BcfArchive {
  version: string
  projectId: string | null
  projectName: string | null
  topics: BcfArchiveTopic[]
}

export class BcfArchiveError extends Error {}

/** Uncompressed size we are willing to unpack (snapshots dominate). */
const MAX_UNPACKED_BYTES = 512 * 1024 * 1024

// --- reading -----------------------------------------------------------------

type XmlNode = Record<string, unknown>

// Elements that repeat. Matched on the path where BCF 2.x and 3.0 use the
// same name for different things (2.1 repeats <Labels>, <Comment> and
// <Viewpoints> directly; 3.0 wraps <Label>, <Comment> and <ViewPoint> in a
// container of the plural name).
const REPEATED_TAGS = new Set([
  'Label',
  'ReferenceLink',
  'DocumentReference',
  'RelatedTopic',
  'ViewPoint',
  'Component',
  'Color',
  'Line',
  'ClippingPlane',
  'Bitmap'
])
const REPEATED_PATHS = new Set([
  'Markup.Topic.Labels',
  'Markup.Comment',
  'Markup.Topic.Comments.Comment',
  'Markup.Viewpoints'
])

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name, jpath) => REPEATED_TAGS.has(name) || REPEATED_PATHS.has(jpath)
})

const parseXml = (bytes: Uint8Array, file: string): XmlNode => {
  try {
    return parser.parse(strFromU8(bytes)) as XmlNode
  } catch (e) {
    throw new BcfArchiveError(`${file} is not valid XML: ${(e as Error).message}`)
  }
}

const node = (value: unknown): XmlNode | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as XmlNode)
    : undefined
const list = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]
/** Element text: a plain string, or #text when the element also has attributes. */
const text = (value: unknown): string | null => {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  const own = node(value)?.['#text']
  return own === undefined ? null : String(own)
}
const attr = (value: unknown, name: string): string | null => {
  const raw = node(value)?.[`@${name}`]
  return raw === undefined || raw === null || raw === '' ? null : String(raw)
}
/** 2.1 spells it isExternal, 3.0 IsExternal. */
const isExternalAttr = (value: unknown) =>
  bool(attr(value, 'IsExternal') ?? attr(value, 'isExternal'))
const nonEmpty = (value: string | null) => (value && value.trim() ? value.trim() : null)
const num = (value: unknown): number | null => {
  const raw = text(value)
  if (raw === null || raw.trim() === '') return null
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}
const bool = (value: string | null): boolean | null =>
  value === null ? null : value.toLowerCase() === 'true'

const vector = (value: unknown) => {
  const n = node(value)
  const x = num(n?.X)
  const y = num(n?.Y)
  const z = num(n?.Z)
  return x === null || y === null || z === null ? null : { x, y, z }
}

const component = (value: unknown): BcfComponent => ({
  ifc_guid: attr(value, 'IfcGuid'),
  originating_system: nonEmpty(text(node(value)?.OriginatingSystem)),
  authoring_tool_id: nonEmpty(text(node(value)?.AuthoringToolId))
})
const components = (container: unknown) =>
  list(node(container)?.Component).map(component)

const camera = (value: unknown, orthogonal: boolean): BcfCamera | null => {
  const n = node(value)
  if (!n) return null
  const viewPoint = vector(n.CameraViewPoint)
  const direction = vector(n.CameraDirection)
  const up = vector(n.CameraUpVector)
  if (!viewPoint || !direction || !up) return null
  return {
    camera_view_point: viewPoint,
    camera_direction: direction,
    camera_up_vector: up,
    ...(orthogonal
      ? { view_to_world_scale: num(n.ViewToWorldScale) ?? 1 }
      : { field_of_view: num(n.FieldOfView) ?? 60 }),
    aspect_ratio: num(n.AspectRatio)
  }
}

const viewSetupHints = (value: unknown) => {
  const n = node(value)
  if (!n) return null
  return {
    spaces_visible: bool(attr(n, 'SpacesVisible')),
    space_boundaries_visible: bool(attr(n, 'SpaceBoundariesVisible')),
    openings_visible: bool(attr(n, 'OpeningsVisible'))
  }
}

/** A .bcfv VisualizationInfo -> stored BCF viewpoint. */
export const parseVisualizationInfo = (doc: XmlNode): BcfViewpointData => {
  const info = node(doc.VisualizationInfo)
  if (!info) return emptyBcfViewpoint()
  const comps = node(info.Components)
  const visibility = node(comps?.Visibility)
  return {
    perspective_camera: camera(info.PerspectiveCamera, false),
    orthogonal_camera: info.PerspectiveCamera ? null : camera(info.OrthogonalCamera, true),
    lines: list(node(info.Lines)?.Line)
      .map((line) => ({
        start_point: vector(node(line)?.StartPoint),
        end_point: vector(node(line)?.EndPoint)
      }))
      .filter(
        (l): l is { start_point: NonNullable<typeof l.start_point>; end_point: NonNullable<typeof l.end_point> } =>
          !!l.start_point && !!l.end_point
      ),
    clipping_planes: list(node(info.ClippingPlanes)?.ClippingPlane)
      .map((plane) => ({
        location: vector(node(plane)?.Location),
        direction: vector(node(plane)?.Direction)
      }))
      .filter(
        (p): p is { location: NonNullable<typeof p.location>; direction: NonNullable<typeof p.direction> } =>
          !!p.location && !!p.direction
      ),
    components: {
      selection: components(comps?.Selection),
      // 3.0 wraps a Color's components in <Components>; 2.1 does not.
      coloring: list(node(comps?.Coloring)?.Color).map((group) => ({
        color: attr(group, 'Color') || 'FF000000',
        components: [...components(group), ...components(node(group)?.Components)]
      })),
      visibility: {
        // BCF 2.0 had no <Visibility>: everything visible.
        default_visibility: bool(attr(visibility, 'DefaultVisibility')) ?? true,
        exceptions: components(visibility?.Exceptions),
        // 2.1 keeps ViewSetupHints under Components, 3.0 under Visibility.
        view_setup_hints:
          viewSetupHints(visibility?.ViewSetupHints) ?? viewSetupHints(comps?.ViewSetupHints)
      }
    }
  }
}

const snapshotType = (fileName: string): 'png' | 'jpg' | null => {
  const ext = fileName.split('.').pop()?.toLowerCase()
  if (ext === 'png') return 'png'
  if (ext === 'jpg' || ext === 'jpeg') return 'jpg'
  return null
}

const parseComment = (value: unknown): BcfArchiveComment | null => {
  const n = node(value)
  const guid = attr(n, 'Guid')
  if (!n || !guid) return null
  return {
    guid,
    date: nonEmpty(text(n.Date)),
    author: nonEmpty(text(n.Author)),
    text: text(n.Comment) || '',
    viewpointGuid: attr(n.Viewpoint, 'Guid'),
    modifiedDate: nonEmpty(text(n.ModifiedDate)),
    modifiedAuthor: nonEmpty(text(n.ModifiedAuthor))
  }
}

/**
 * Reads a .bcf / .bcfzip archive. Topics are the folders holding a
 * markup.bcf; everything else (extensions, project file, documents) is
 * optional and only the project name/id are taken from it.
 */
export const readBcfArchive = (data: Uint8Array): BcfArchive => {
  let unpackedBytes = 0
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(data, {
      filter: (file) => {
        unpackedBytes += file.originalSize
        if (unpackedBytes > MAX_UNPACKED_BYTES) {
          throw new BcfArchiveError('The BCF archive is too large to unpack')
        }
        return !file.name.endsWith('/')
      }
    })
  } catch (e) {
    if (e instanceof BcfArchiveError) throw e
    throw new BcfArchiveError('The file is not a BCF archive (not a zip file)')
  }

  // Some tools wrap everything in one top-level folder: strip it.
  const names = Object.keys(files).map((n) => n.replace(/\\/g, '/'))
  const byName = new Map(Object.entries(files).map(([n, v]) => [n.replace(/\\/g, '/'), v]))
  const markups = names.filter((n) => n.toLowerCase().endsWith('markup.bcf'))
  if (!markups.length) {
    throw new BcfArchiveError('The archive contains no BCF topics (no markup.bcf)')
  }
  const findFile = (name: string) => {
    if (byName.has(name)) return byName.get(name)
    const lower = name.toLowerCase()
    const match = names.find((n) => n.toLowerCase() === lower)
    return match ? byName.get(match) : undefined
  }
  const prefixOf = (markupPath: string) => markupPath.slice(0, markupPath.lastIndexOf('/') + 1)
  const markupFolders = markups.map(prefixOf)
  const rootPrefix = markupFolders.every((f) => f.split('/').length > 2)
    ? markupFolders[0].split('/')[0] + '/'
    : ''

  const versionFile = findFile(`${rootPrefix}bcf.version`)
  const versionDoc = versionFile ? parseXml(versionFile, 'bcf.version') : null
  const version = attr(versionDoc?.Version, 'VersionId') || '2.1'

  let projectId: string | null = null
  let projectName: string | null = null
  const projectFile = findFile(`${rootPrefix}project.bcfp`)
  if (projectFile) {
    const project = node(node(parseXml(projectFile, 'project.bcfp').ProjectInfo)?.Project) ||
      node(node(parseXml(projectFile, 'project.bcfp').ProjectExtension)?.Project)
    projectId = attr(project, 'ProjectId')
    projectName = nonEmpty(text(project?.Name))
  }

  const topics: BcfArchiveTopic[] = []
  for (const markupPath of markups) {
    const folder = prefixOf(markupPath)
    const markup = node(parseXml(byName.get(markupPath)!, markupPath).Markup)
    const topic = node(markup?.Topic)
    const topicGuid = attr(topic, 'Guid') || folder.split('/').filter(Boolean).pop() || null
    if (!markup || !topic || !topicGuid) continue

    // 2.1: <Labels>a</Labels><Labels>b</Labels>; 3.0: <Labels><Label>a</Label></Labels>
    const labels = list(topic.Labels).flatMap((entry) =>
      typeof entry === 'string' ? [entry] : list(node(entry)?.Label).map((l) => text(l))
    )
    const referenceLinks = [
      ...list(topic.ReferenceLink),
      ...list(node(topic.ReferenceLinks)?.ReferenceLink)
    ].map((l) => text(l))
    const documentReferences = [
      ...list(topic.DocumentReference),
      ...list(node(topic.DocumentReferences)?.DocumentReference)
    ].map((ref) => {
      const n = node(ref)
      const referenced = nonEmpty(text(n?.ReferencedDocument))
      // 2.1 points at a file (inside the archive when IsExternal is false)
      // or a URL; 3.0 has DocumentGuid (project document) or Url.
      const isExternal = isExternalAttr(n) ?? true
      return {
        guid: attr(n, 'Guid'),
        documentGuid: nonEmpty(text(n?.DocumentGuid)),
        url: nonEmpty(text(n?.Url)) || (isExternal ? referenced : null),
        description: nonEmpty(text(n?.Description)) || (!isExternal ? referenced : null)
      }
    })
    const relatedTopicGuids = [
      ...list(topic.RelatedTopic),
      ...list(node(topic.RelatedTopics)?.RelatedTopic)
    ]
      .map((r) => attr(r, 'Guid'))
      .filter((g): g is string => !!g)

    const snippet = node(topic.BimSnippet)
    const bimSnippet: BcfBimSnippet | null = snippet
      ? {
          snippet_type: attr(snippet, 'SnippetType') || '',
          is_external: isExternalAttr(snippet) ?? false,
          reference: text(snippet.Reference) || '',
          reference_schema: text(snippet.ReferenceSchema) || ''
        }
      : null

    // Viewpoints: 2.x <Markup><Viewpoints Guid>, 3.0 <Topic><Viewpoints><ViewPoint Guid>.
    const viewpointEntries = [
      ...list(markup.Viewpoints),
      ...list(node(topic.Viewpoints)?.ViewPoint)
    ]
    const viewpointRefs = viewpointEntries
      .map((entry) => ({
        guid: attr(entry, 'Guid'),
        file: nonEmpty(text(node(entry)?.Viewpoint)),
        snapshot: nonEmpty(text(node(entry)?.Snapshot)),
        index: num(node(entry)?.Index)
      }))
      .filter((v) => v.guid || v.file)
    // BCF 2.0 may list nothing and rely on the default file names.
    if (!viewpointRefs.length && findFile(`${folder}viewpoint.bcfv`)) {
      viewpointRefs.push({
        guid: null,
        file: 'viewpoint.bcfv',
        snapshot: findFile(`${folder}snapshot.png`) ? 'snapshot.png' : null,
        index: null
      })
    }
    const viewpoints: BcfArchiveViewpoint[] = []
    for (const ref of viewpointRefs) {
      const vpFile = ref.file ? findFile(folder + ref.file) : undefined
      const vpDoc = vpFile ? parseXml(vpFile, folder + ref.file) : null
      const guid = ref.guid || attr(vpDoc?.VisualizationInfo, 'Guid')
      if (!guid) continue
      const snapshotBytes = ref.snapshot ? findFile(folder + ref.snapshot) : undefined
      const type = ref.snapshot ? snapshotType(ref.snapshot) : null
      viewpoints.push({
        guid,
        index: ref.index,
        bcf: vpDoc ? parseVisualizationInfo(vpDoc) : emptyBcfViewpoint(),
        snapshot: snapshotBytes && type ? { type, data: snapshotBytes } : null
      })
    }

    const comments = [
      ...list(markup.Comment),
      ...list(node(topic.Comments)?.Comment)
    ]
      .map(parseComment)
      .filter((c): c is BcfArchiveComment => !!c)

    topics.push({
      guid: topicGuid,
      topicType: attr(topic, 'TopicType'),
      topicStatus: attr(topic, 'TopicStatus'),
      serverAssignedId: attr(topic, 'ServerAssignedId'),
      title: nonEmpty(text(topic.Title)) || 'Untitled topic',
      priority: nonEmpty(text(topic.Priority)),
      index: num(topic.Index),
      labels: labels.map(nonEmpty).filter((l): l is string => !!l),
      referenceLinks: referenceLinks.map(nonEmpty).filter((l): l is string => !!l),
      creationDate: nonEmpty(text(topic.CreationDate)),
      creationAuthor: nonEmpty(text(topic.CreationAuthor)),
      modifiedDate: nonEmpty(text(topic.ModifiedDate)),
      modifiedAuthor: nonEmpty(text(topic.ModifiedAuthor)),
      dueDate: nonEmpty(text(topic.DueDate)),
      assignedTo: nonEmpty(text(topic.AssignedTo)),
      stage: nonEmpty(text(topic.Stage)),
      description: text(topic.Description) || '',
      bimSnippet,
      documentReferences,
      relatedTopicGuids,
      comments,
      viewpoints
    })
  }

  if (!topics.length) {
    throw new BcfArchiveError('The archive contains no readable BCF topics')
  }
  return { version, projectId, projectName, topics }
}

// --- writing -----------------------------------------------------------------

const escapeXml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // XML 1.0 forbids most control characters
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')

/** <Name>value</Name>, or nothing for an empty value. */
const el = (name: string, value: string | number | null | undefined) =>
  value === null || value === undefined || value === ''
    ? ''
    : `<${name}>${escapeXml(String(value))}</${name}>`
const attrs = (values: Record<string, string | number | boolean | null | undefined>) =>
  Object.entries(values)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => ` ${k}="${escapeXml(String(v))}"`)
    .join('')

const xmlHeader = '<?xml version="1.0" encoding="utf-8"?>\n'
const XSI = 'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"'
// BCF 3.0 requires TopicType and TopicStatus; topics without them get these
// in the file only.
const DEFAULT_TOPIC_TYPE = 'Issue'
const DEFAULT_TOPIC_STATUS = 'Open'

const DEFAULT_CAMERA: BcfCamera = {
  camera_view_point: { x: 0, y: 0, z: 0 },
  camera_direction: { x: 0, y: 1, z: 0 },
  camera_up_vector: { x: 0, y: 0, z: 1 },
  field_of_view: 60,
  aspect_ratio: 1
}

const writeVector = (name: string, v: { x: number; y: number; z: number }) =>
  `<${name}><X>${v.x}</X><Y>${v.y}</Y><Z>${v.z}</Z></${name}>`

const writeComponent = (c: BcfComponent) =>
  `<Component${attrs({ IfcGuid: c.ifc_guid })}>${el('OriginatingSystem', c.originating_system)}${el('AuthoringToolId', c.authoring_tool_id)}</Component>`

const writeCamera = (name: string, c: BcfCamera, version: BcfVersion, ortho: boolean) =>
  `<${name}>${writeVector('CameraViewPoint', c.camera_view_point)}${writeVector(
    'CameraDirection',
    c.camera_direction
  )}${writeVector('CameraUpVector', c.camera_up_vector)}${
    ortho
      ? el('ViewToWorldScale', c.view_to_world_scale ?? 1)
      : el('FieldOfView', c.field_of_view ?? 60)
  }${version === '3.0' ? el('AspectRatio', c.aspect_ratio ?? 1) : ''}</${name}>`

export const writeVisualizationInfo = (
  guid: string,
  vp: BcfViewpointData,
  version: BcfVersion
) => {
  const hints = vp.components.visibility.view_setup_hints
  const hintsXml = hints
    ? `<ViewSetupHints${attrs({
        SpacesVisible: hints.spaces_visible,
        SpaceBoundariesVisible: hints.space_boundaries_visible,
        OpeningsVisible: hints.openings_visible
      })}/>`
    : ''
  const { selection, coloring, visibility } = vp.components
  const componentsXml =
    (version === '2.1' ? hintsXml : '') +
    (selection.length
      ? `<Selection>${selection.map(writeComponent).join('')}</Selection>`
      : '') +
    `<Visibility${attrs({ DefaultVisibility: visibility.default_visibility })}>${
      version === '3.0' ? hintsXml : ''
    }${
      visibility.exceptions.length
        ? `<Exceptions>${visibility.exceptions.map(writeComponent).join('')}</Exceptions>`
        : ''
    }</Visibility>` +
    (coloring.some((g) => g.components.length)
      ? `<Coloring>${coloring
          .filter((g) => g.components.length)
          .map((g) => {
            const inner = g.components.map(writeComponent).join('')
            return `<Color${attrs({ Color: g.color })}>${
              version === '3.0' ? `<Components>${inner}</Components>` : inner
            }</Color>`
          })
          .join('')}</Coloring>`
      : '')
  const cameraXml = vp.orthogonal_camera
    ? writeCamera('OrthogonalCamera', vp.orthogonal_camera, version, true)
    : vp.perspective_camera
    ? writeCamera('PerspectiveCamera', vp.perspective_camera, version, false)
    : version === '3.0'
    ? // 3.0 requires a camera; a snapshot-only viewpoint gets a neutral one.
      writeCamera('PerspectiveCamera', DEFAULT_CAMERA, version, false)
    : ''
  const linesXml = vp.lines.length
    ? `<Lines>${vp.lines
        .map(
          (l) =>
            `<Line>${writeVector('StartPoint', l.start_point)}${writeVector(
              'EndPoint',
              l.end_point
            )}</Line>`
        )
        .join('')}</Lines>`
    : ''
  const planesXml = vp.clipping_planes.length
    ? `<ClippingPlanes>${vp.clipping_planes
        .map(
          (p) =>
            `<ClippingPlane>${writeVector('Location', p.location)}${writeVector(
              'Direction',
              p.direction
            )}</ClippingPlane>`
        )
        .join('')}</ClippingPlanes>`
    : ''
  return `${xmlHeader}<VisualizationInfo ${XSI}${attrs({ Guid: guid })}><Components>${componentsXml}</Components>${cameraXml}${linesXml}${planesXml}</VisualizationInfo>`
}

const writeComment = (c: BcfArchiveComment) =>
  `<Comment${attrs({ Guid: c.guid })}>${el('Date', c.date)}${el('Author', c.author)}${el(
    'Comment',
    c.text
  )}${c.viewpointGuid ? `<Viewpoint${attrs({ Guid: c.viewpointGuid })}/>` : ''}${el(
    'ModifiedDate',
    c.modifiedDate
  )}${el('ModifiedAuthor', c.modifiedAuthor)}</Comment>`

const viewpointFiles = (vp: BcfArchiveViewpoint) => ({
  viewpoint: `${vp.guid}.bcfv`,
  snapshot: vp.snapshot ? `${vp.guid}.${vp.snapshot.type}` : null
})

export const writeMarkup = (topic: BcfArchiveTopic, version: BcfVersion) => {
  const v3 = version === '3.0'
  const docRefs = topic.documentReferences.map((d) =>
    v3
      ? `<DocumentReference${attrs({ Guid: d.guid })}>${
          d.documentGuid ? el('DocumentGuid', d.documentGuid) : el('Url', d.url)
        }${el('Description', d.description)}</DocumentReference>`
      : `<DocumentReference${attrs({ Guid: d.guid, isExternal: true })}>${el(
          'ReferencedDocument',
          d.url || d.documentGuid
        )}${el('Description', d.description)}</DocumentReference>`
  )
  const snippet = topic.bimSnippet
    ? `<BimSnippet${attrs({
        SnippetType: topic.bimSnippet.snippet_type,
        [v3 ? 'IsExternal' : 'isExternal']: topic.bimSnippet.is_external
      })}>${el('Reference', topic.bimSnippet.reference)}${el(
        'ReferenceSchema',
        topic.bimSnippet.reference_schema
      )}</BimSnippet>`
    : ''
  const related = topic.relatedTopicGuids.map((g) => `<RelatedTopic${attrs({ Guid: g })}/>`)
  const viewpoints = topic.viewpoints.map((vp) => {
    const files = viewpointFiles(vp)
    const inner = `${el('Viewpoint', files.viewpoint)}${el('Snapshot', files.snapshot)}${el(
      'Index',
      vp.index
    )}`
    return v3
      ? `<ViewPoint${attrs({ Guid: vp.guid })}>${inner}</ViewPoint>`
      : `<Viewpoints${attrs({ Guid: vp.guid })}>${inner}</Viewpoints>`
  })
  const comments = topic.comments.map(writeComment)

  const topicXml = v3
    ? `<Topic${attrs({
        Guid: topic.guid,
        ServerAssignedId: topic.serverAssignedId,
        TopicType: topic.topicType || DEFAULT_TOPIC_TYPE,
        TopicStatus: topic.topicStatus || DEFAULT_TOPIC_STATUS
      })}>${
        topic.referenceLinks.length
          ? `<ReferenceLinks>${topic.referenceLinks.map((l) => el('ReferenceLink', l)).join('')}</ReferenceLinks>`
          : ''
      }${el('Title', topic.title)}${el('Priority', topic.priority)}${
        topic.labels.length
          ? `<Labels>${topic.labels.map((l) => el('Label', l)).join('')}</Labels>`
          : ''
      }${el('CreationDate', topic.creationDate)}${el('CreationAuthor', topic.creationAuthor)}${el(
        'ModifiedDate',
        topic.modifiedDate
      )}${el('ModifiedAuthor', topic.modifiedAuthor)}${el('DueDate', topic.dueDate)}${el(
        'AssignedTo',
        topic.assignedTo
      )}${el('Stage', topic.stage)}${el('Description', topic.description)}${snippet}${
        docRefs.length ? `<DocumentReferences>${docRefs.join('')}</DocumentReferences>` : ''
      }${related.length ? `<RelatedTopics>${related.join('')}</RelatedTopics>` : ''}${
        comments.length ? `<Comments>${comments.join('')}</Comments>` : ''
      }${viewpoints.length ? `<Viewpoints>${viewpoints.join('')}</Viewpoints>` : ''}</Topic>`
    : `<Topic${attrs({
        Guid: topic.guid,
        TopicType: topic.topicType,
        TopicStatus: topic.topicStatus
      })}>${topic.referenceLinks.map((l) => el('ReferenceLink', l)).join('')}${el(
        'Title',
        topic.title
      )}${el('Priority', topic.priority)}${el('Index', topic.index)}${topic.labels
        .map((l) => el('Labels', l))
        .join('')}${el('CreationDate', topic.creationDate)}${el(
        'CreationAuthor',
        topic.creationAuthor
      )}${el('ModifiedDate', topic.modifiedDate)}${el('ModifiedAuthor', topic.modifiedAuthor)}${el(
        'DueDate',
        topic.dueDate
      )}${el('AssignedTo', topic.assignedTo)}${el('Stage', topic.stage)}${el(
        'Description',
        topic.description
      )}${snippet}${docRefs.join('')}${related.join('')}</Topic>`

  return `${xmlHeader}<Markup ${XSI}>${topicXml}${v3 ? '' : comments.join('') + viewpoints.join('')}</Markup>`
}

/** Builds a .bcf (3.0) / .bcfzip (2.1) archive. */
export const writeBcfArchive = (params: {
  version: BcfVersion
  projectId: string
  projectName: string
  topics: BcfArchiveTopic[]
}): Uint8Array => {
  const { version, topics } = params
  const files: Record<string, Uint8Array> = {
    'bcf.version': strToU8(
      version === '3.0'
        ? `${xmlHeader}<Version ${XSI} VersionId="3.0"/>`
        : `${xmlHeader}<Version ${XSI} VersionId="2.1"><DetailedVersion>2.1</DetailedVersion></Version>`
    ),
    'project.bcfp': strToU8(
      version === '3.0'
        ? `${xmlHeader}<ProjectInfo ${XSI}><Project${attrs({ ProjectId: params.projectId })}>${el(
            'Name',
            params.projectName
          )}</Project></ProjectInfo>`
        : `${xmlHeader}<ProjectExtension ${XSI}><Project${attrs({
            ProjectId: params.projectId
          })}>${el('Name', params.projectName)}</Project><ExtensionSchema></ExtensionSchema></ProjectExtension>`
    )
  }
  if (version === '3.0') {
    const unique = (values: Array<string | null>) =>
      [...new Set(values.filter((v): v is string => !!v))].sort()
    const section = (name: string, item: string, values: string[]) =>
      values.length ? `<${name}>${values.map((v) => el(item, v)).join('')}</${name}>` : ''
    files['extensions.xml'] = strToU8(
      `${xmlHeader}<Extensions ${XSI}>${section(
        'TopicTypes',
        'TopicType',
        unique(topics.map((t) => t.topicType || DEFAULT_TOPIC_TYPE))
      )}${section(
        'TopicStatuses',
        'TopicStatus',
        unique(topics.map((t) => t.topicStatus || DEFAULT_TOPIC_STATUS))
      )}${section(
        'Priorities',
        'Priority',
        unique(topics.map((t) => t.priority))
      )}${section('TopicLabels', 'TopicLabel', unique(topics.flatMap((t) => t.labels)))}${section(
        'Stages',
        'Stage',
        unique(topics.map((t) => t.stage))
      )}${section(
        'Users',
        'User',
        unique(
          topics.flatMap((t) => [
            t.creationAuthor,
            t.modifiedAuthor,
            t.assignedTo,
            ...t.comments.flatMap((c) => [c.author, c.modifiedAuthor])
          ])
        )
      )}</Extensions>`
    )
  }
  for (const topic of topics) {
    const folder = `${topic.guid}/`
    files[`${folder}markup.bcf`] = strToU8(writeMarkup(topic, version))
    for (const vp of topic.viewpoints) {
      const names = viewpointFiles(vp)
      files[folder + names.viewpoint] = strToU8(
        writeVisualizationInfo(vp.guid, vp.bcf, version)
      )
      if (vp.snapshot && names.snapshot) files[folder + names.snapshot] = vp.snapshot.data
    }
  }
  // Snapshots are already compressed: store them, deflate the XML.
  return zipSync(
    Object.fromEntries(
      Object.entries(files).map(([name, bytes]) => [
        name,
        [bytes, { level: /\.(png|jpe?g)$/i.test(name) ? 0 : 6 }]
      ])
    )
  )
}
