/**
 * BCF 3.0 viewpoint conversions. A stored viewpoint (topic_viewpoints) keeps
 * the BCF viewpoint itself in the spec's snake_case wire shape (`bcf`) and,
 * separately, the Speckle viewer state (`data`) used to restore the exact 3D
 * view. This module converts between those and the GraphQL shapes.
 *
 * Kept independent of generated GraphQL types (plain structural interfaces),
 * same as services/data.ts.
 */
/* eslint-disable camelcase -- the stored `bcf` shape is BCF's own snake_case wire format */
import type {
  BcfCamera,
  BcfComponent,
  BcfViewpointData,
  TopicViewpointRecord
} from '@/modules/comments/helpers/types'
import type { ViewpointInputData } from '@/modules/comments/services/data'
import { formatSerializedViewerState } from '@/modules/comments/services/data'
import type { SerializedViewerState } from '@speckle/shared/viewer/state'

type Vec3 = { x: number; y: number; z: number }
type Maybe<T> = T | null | undefined

type CameraIo = {
  cameraViewPoint: Vec3
  cameraDirection: Vec3
  cameraUpVector: Vec3
  fieldOfView?: Maybe<number>
  viewToWorldScale?: Maybe<number>
  aspectRatio?: Maybe<number>
}
type ComponentIo = {
  ifcGuid?: Maybe<string>
  originatingSystem?: Maybe<string>
  authoringToolId?: Maybe<string>
}

/** The BCF 3.0 nested part of ViewpointInput, on top of the older flat fields. */
export interface BcfViewpointInputData extends ViewpointInputData {
  guid?: Maybe<string>
  index?: Maybe<number>
  perspectiveCamera?: Maybe<CameraIo>
  orthogonalCamera?: Maybe<CameraIo>
  lines?: Maybe<Array<{ startPoint: Vec3; endPoint: Vec3 }>>
  components?: Maybe<{
    selection?: Maybe<ComponentIo[]>
    coloring?: Maybe<Array<{ color: string; components: ComponentIo[] }>>
    visibility?: Maybe<{
      defaultVisibility?: Maybe<boolean>
      exceptions?: Maybe<ComponentIo[]>
      viewSetupHints?: Maybe<{
        spacesVisible?: Maybe<boolean>
        spaceBoundariesVisible?: Maybe<boolean>
        openingsVisible?: Maybe<boolean>
      }>
    }>
  }>
  snapshotType?: Maybe<string>
}

const vec = (v: Vec3): Vec3 => ({ x: v.x, y: v.y, z: v.z })
const arrToVec = (a?: Maybe<number[]>): Vec3 | null =>
  a && a.length === 3 ? { x: a[0], y: a[1], z: a[2] } : null
const normalize = (v: Vec3): Vec3 => {
  const len = Math.hypot(v.x, v.y, v.z) || 1
  return { x: v.x / len, y: v.y / len, z: v.z / len }
}

const componentToBcf = (c: ComponentIo): BcfComponent => ({
  ifc_guid: c.ifcGuid ?? null,
  originating_system: c.originatingSystem ?? null,
  authoring_tool_id: c.authoringToolId ?? null
})
const componentFromBcf = (c: BcfComponent) => ({
  ifcGuid: c.ifc_guid ?? null,
  originatingSystem: c.originating_system ?? null,
  authoringToolId: c.authoring_tool_id ?? null
})
const guidOnly = (ifcGuid: string): BcfComponent => ({
  ifc_guid: ifcGuid,
  originating_system: null,
  authoring_tool_id: null
})

const cameraToBcf = (c: CameraIo, isOrtho: boolean): BcfCamera => ({
  camera_view_point: vec(c.cameraViewPoint),
  camera_direction: vec(c.cameraDirection),
  camera_up_vector: vec(c.cameraUpVector),
  ...(isOrtho
    ? { view_to_world_scale: c.viewToWorldScale ?? 1 }
    : { field_of_view: c.fieldOfView ?? 60 }),
  aspect_ratio: c.aspectRatio ?? null
})
const cameraFromBcf = (c: Maybe<BcfCamera>) =>
  c
    ? {
        cameraViewPoint: c.camera_view_point,
        cameraDirection: c.camera_direction,
        cameraUpVector: c.camera_up_vector,
        fieldOfView: c.field_of_view ?? null,
        viewToWorldScale: c.view_to_world_scale ?? null,
        aspectRatio: c.aspect_ratio ?? null
      }
    : null

/**
 * ViewpointInput -> stored BCF viewpoint. Mirrors the external BCF server:
 * a nested (spec) field wins over its flat twin.
 */
export function bcfViewpointFromInput(input: BcfViewpointInputData): BcfViewpointData {
  let perspective: BcfCamera | null = null
  let orthogonal: BcfCamera | null = null
  if (input.perspectiveCamera) {
    perspective = cameraToBcf(input.perspectiveCamera, false)
  } else if (input.orthogonalCamera) {
    orthogonal = cameraToBcf(input.orthogonalCamera, true)
  } else if (input.cameraViewPoint && input.cameraDirection) {
    const flat: CameraIo = {
      cameraViewPoint: input.cameraViewPoint,
      cameraDirection: input.cameraDirection,
      // Same default formatSerializedViewerState() applies to the viewer's
      // own upVector.
      cameraUpVector: input.cameraUpVector || { x: 0, y: 1, z: 0 },
      fieldOfView: input.fieldOfView,
      viewToWorldScale: input.viewToWorldScale
    }
    if (input.isOrthogonal) orthogonal = cameraToBcf(flat, true)
    else perspective = cameraToBcf(flat, false)
  }

  const comps = input.components
  const components: BcfViewpointData['components'] = comps
    ? {
        selection: (comps.selection || []).map(componentToBcf),
        coloring: (comps.coloring || []).map((g) => ({
          color: g.color,
          components: g.components.map(componentToBcf)
        })),
        visibility: {
          default_visibility: comps.visibility?.defaultVisibility ?? true,
          exceptions: (comps.visibility?.exceptions || []).map(componentToBcf),
          view_setup_hints: comps.visibility?.viewSetupHints
            ? {
                spaces_visible: comps.visibility.viewSetupHints.spacesVisible ?? null,
                space_boundaries_visible:
                  comps.visibility.viewSetupHints.spaceBoundariesVisible ?? null,
                openings_visible:
                  comps.visibility.viewSetupHints.openingsVisible ?? null
              }
            : null
        }
      }
    : {
        selection: (input.selection || []).filter(Boolean).map(guidOnly),
        coloring: groupColoring(input.coloring || []),
        visibility: {
          default_visibility: input.defaultVisibility ?? true,
          exceptions: (input.visibilityExceptions || []).filter(Boolean).map(guidOnly),
          view_setup_hints: null
        }
      }

  return {
    perspective_camera: perspective,
    orthogonal_camera: orthogonal,
    lines: (input.lines || []).map((l) => ({
      start_point: vec(l.startPoint),
      end_point: vec(l.endPoint)
    })),
    clipping_planes: (input.clippingPlanes || []).map((p) => ({
      location: vec(p.location),
      direction: vec(p.direction)
    })),
    components
  }
}

const groupColoring = (
  flat: Array<{ ifcGuid: string; color: string }>
): BcfViewpointData['components']['coloring'] => {
  const byColor = new Map<string, BcfComponent[]>()
  for (const { ifcGuid, color } of flat) {
    if (!ifcGuid) continue
    byColor.set(color, [...(byColor.get(color) || []), guidOnly(ifcGuid)])
  }
  return [...byColor.entries()].map(([color, components]) => ({ color, components }))
}

/**
 * Speckle viewer state -> BCF viewpoint, for viewpoints captured in the
 * Speckle viewer (and rows stored before `bcf` existed).
 */
export function bcfViewpointFromState(state: SerializedViewerState): BcfViewpointData {
  const cam = state.ui.camera
  const position = arrToVec(cam.position)
  const target = arrToVec(cam.target)
  const direction =
    arrToVec(cam.direction) ||
    (position && target
      ? normalize({
          x: target.x - position.x,
          y: target.y - position.y,
          z: target.z - position.z
        })
      : null)

  let perspective: BcfCamera | null = null
  let orthogonal: BcfCamera | null = null
  if (position && direction) {
    const c: CameraIo = {
      cameraViewPoint: position,
      cameraDirection: direction,
      cameraUpVector: arrToVec(cam.upVector) || { x: 0, y: 1, z: 0 },
      fieldOfView: cam.fieldOfView,
      viewToWorldScale: cam.viewToWorldScale
    }
    if (cam.isOrthoProjection) orthogonal = cameraToBcf(c, true)
    else perspective = cameraToBcf(c, false)
  }

  // Values are the objects' applicationIds (IFC GUIDs for IFC-sourced
  // models); keys are the viewer's own object ids, the fallback.
  const selected = Object.entries(state.ui.filters.selectedObjectApplicationIds || {})
  return {
    perspective_camera: perspective,
    orthogonal_camera: orthogonal,
    lines: [],
    clipping_planes: state.ui.bcf.clippingPlanes
      .map((p) => ({
        location: arrToVec(p.location),
        direction: arrToVec(p.direction)
      }))
      .filter(
        (p): p is { location: Vec3; direction: Vec3 } => !!p.location && !!p.direction
      ),
    components: {
      selection: selected.map(([id, appId]) => guidOnly(appId || id)),
      coloring: groupColoring(state.ui.bcf.coloring),
      visibility: {
        default_visibility: state.ui.bcf.defaultVisibility,
        exceptions: state.ui.bcf.visibilityExceptions.map(guidOnly),
        view_setup_hints: null
      }
    }
  }
}

/**
 * Stored BCF viewpoint -> the ViewpointInputData shape services/data.ts's
 * viewpointInputToPartialState() takes, to derive a Speckle viewer state
 * for a viewpoint that arrived BCF-only.
 */
export function bcfViewpointToFlatInput(bcf: BcfViewpointData): ViewpointInputData {
  const cam = bcf.perspective_camera || bcf.orthogonal_camera
  const withGuid = (list: BcfComponent[]) =>
    list.map((c) => c.ifc_guid).filter((g): g is string => !!g)
  return {
    isOrthogonal: !!bcf.orthogonal_camera,
    cameraViewPoint: cam?.camera_view_point ?? null,
    cameraDirection: cam?.camera_direction ?? null,
    cameraUpVector: cam?.camera_up_vector ?? null,
    fieldOfView: cam?.field_of_view ?? null,
    viewToWorldScale: cam?.view_to_world_scale ?? null,
    clippingPlanes: bcf.clipping_planes,
    defaultVisibility: bcf.components.visibility.default_visibility,
    selection: withGuid(bcf.components.selection),
    visibilityExceptions: withGuid(bcf.components.visibility.exceptions),
    coloring: bcf.components.coloring.flatMap((g) =>
      withGuid(g.components).map((ifcGuid) => ({ ifcGuid, color: g.color }))
    )
  }
}

/** A stored viewpoint row -> the GraphQL Viewpoint. */
export function viewpointRecordToGraphql(row: TopicViewpointRecord) {
  const state = row.data?.state ? formatSerializedViewerState(row.data.state) : null
  const bcf = row.bcf || (state ? bcfViewpointFromState(state) : emptyBcfViewpoint())
  const flat = bcfViewpointToFlatInput(bcf)
  const cam = bcf.perspective_camera || bcf.orthogonal_camera
  return {
    id: row.id,
    guid: row.guid,
    index: row.index,
    perspectiveCamera: cameraFromBcf(bcf.perspective_camera),
    orthogonalCamera: cameraFromBcf(bcf.orthogonal_camera),
    lines: bcf.lines.map((l) => ({ startPoint: l.start_point, endPoint: l.end_point })),
    components: {
      selection: bcf.components.selection.map(componentFromBcf),
      coloring: bcf.components.coloring.map((g) => ({
        color: g.color,
        components: g.components.map(componentFromBcf)
      })),
      visibility: {
        defaultVisibility: bcf.components.visibility.default_visibility,
        exceptions: bcf.components.visibility.exceptions.map(componentFromBcf),
        viewSetupHints: bcf.components.visibility.view_setup_hints
          ? {
              spacesVisible: bcf.components.visibility.view_setup_hints.spaces_visible,
              spaceBoundariesVisible:
                bcf.components.visibility.view_setup_hints.space_boundaries_visible,
              openingsVisible:
                bcf.components.visibility.view_setup_hints.openings_visible
            }
          : null
      }
    },
    snapshotType: row.screenshot ? row.snapshotType || 'png' : null,
    isOrthogonal: !!bcf.orthogonal_camera,
    cameraViewPoint: cam?.camera_view_point ?? null,
    cameraDirection: cam?.camera_direction ?? null,
    cameraUpVector: cam?.camera_up_vector ?? null,
    fieldOfView: cam?.field_of_view ?? null,
    viewToWorldScale: cam?.view_to_world_scale ?? null,
    clippingPlanes: bcf.clipping_planes,
    defaultVisibility: bcf.components.visibility.default_visibility,
    selection: flat.selection || [],
    visibilityExceptions: flat.visibilityExceptions || [],
    coloring: flat.coloring || [],
    snapshot: row.screenshot,
    viewerState: state
  }
}

export const emptyBcfViewpoint = (): BcfViewpointData => ({
  perspective_camera: null,
  orthogonal_camera: null,
  lines: [],
  clipping_planes: [],
  components: {
    selection: [],
    coloring: [],
    visibility: { default_visibility: true, exceptions: [], view_setup_hints: null }
  }
})

/** BCF 3.0 snapshot_type is 'png' or 'jpg'. */
export const normalizeSnapshotType = (t: Maybe<string>): string => {
  const v = (t || 'png').toLowerCase()
  if (v === 'jpeg') return 'jpg'
  if (v !== 'png' && v !== 'jpg') throw new Error('snapshotType must be png or jpg')
  return v
}
