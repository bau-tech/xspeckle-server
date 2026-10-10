import type {
  ConvertLegacyDataToState,
  GetViewerResourcesForComments
} from '@/modules/comments/domain/operations'
import type { LegacyCommentViewerData } from '@/modules/core/graph/generated/graphql'
import { viewerResourcesToString } from '@/modules/viewer/services/viewerResources'
import type {
  VersionedSerializedViewerState,
  SerializedViewerState
} from '@speckle/shared/viewer/state'
import {
  formatSerializedViewerState,
  isVersionedSerializedViewerState,
  isSerializedViewerState,
  inputToVersionedState
} from '@speckle/shared/viewer/state'
import { intersection, isObjectLike } from 'lodash-es'
import type { PartialDeep } from 'type-fest'

export type LegacyData = Partial<LegacyCommentViewerData>
export type DataStruct = VersionedSerializedViewerState

export { formatSerializedViewerState }
export const inputToDataStruct = inputToVersionedState
export const isDataStruct = isVersionedSerializedViewerState

export function isLegacyData(data: unknown): data is LegacyData {
  if (!data) return false
  const keys: Array<keyof LegacyData> = [
    'camPos',
    'filters',
    'location',
    'sectionBox',
    'selection'
  ]
  if (!isObjectLike(data)) return false

  const valKeys = Object.keys(data as Record<string, unknown>)
  if (intersection(valKeys, keys).length !== keys.length) return false

  return true
}

export function convertStateToLegacyData(state: SerializedViewerState): LegacyData {
  const camPos = state.ui.camera.position
  const camTarget = state.ui.camera.target
  const zoom = state.ui.camera.zoom
  const isOrtho = state.ui.camera.isOrthoProjection
  const selection = state.ui.selection
  const selectionLocation = selection || camTarget

  const ret: LegacyData = {
    camPos: [
      camPos[0] || 0,
      camPos[1] || 0,
      camPos[2] || 0,
      camTarget[0] || 0,
      camTarget[1] || 0,
      camTarget[2] || 0,
      zoom || 1,
      isOrtho ? 1 : 0
    ],
    filters: {
      passMin: state.viewer.metadata.filteringState?.passMin || null,
      passMax: state.viewer.metadata.filteringState?.passMax || null,
      hiddenIds: state.ui.filters.hiddenObjectIds.slice(),
      isolatedIds: state.ui.filters.isolatedObjectIds.slice(),
      sectionBox: {
        min: (state.ui?.sectionBox?.min as number[]) || [0, 0, 0],
        max: (state.ui?.sectionBox?.max as number[]) || [0, 0, 0],
        rotation: (state.ui?.sectionBox?.rotation as number[]) || [
          1, 0, 0, 0, 1, 0, 0, 0, 1
        ]
      },
      propertyInfoKey: state.ui.filters.propertyFilters[0]?.key || null
    },
    location: {
      x: selectionLocation[0] || 0,
      y: selectionLocation[1] || 0,
      z: selectionLocation[2] || 0
    },
    sectionBox: {
      min: (state.ui?.sectionBox?.min as number[]) || [0, 0, 0],
      max: (state.ui?.sectionBox?.max as number[]) || [0, 0, 0],
      rotation: (state.ui?.sectionBox?.rotation as number[]) || [
        1, 0, 0, 0, 1, 0, 0, 0, 1
      ]
    },
    selection: null
  }
  return ret
}

export const convertLegacyDataToStateFactory =
  (deps: {
    getViewerResourcesForComments: GetViewerResourcesForComments
  }): ConvertLegacyDataToState =>
  async (data, comment) => {
    const resources = await deps.getViewerResourcesForComments(comment.streamId, [
      comment.id
    ])
    const sectionBox = data.filters?.sectionBox || data.sectionBox

    const ret: SerializedViewerState = {
      projectId: comment.streamId,
      sessionId: 'legacy-sessionId',
      viewer: {
        metadata: {
          filteringState: {
            passMax: data.filters?.passMax,
            passMin: data.filters?.passMin
          }
        }
      },
      resources: {
        request: {
          resourceIdString: viewerResourcesToString(resources),
          threadFilters: {
            includeArchived: false,
            loadedVersionsOnly: false
          }
        }
      },
      ui: {
        threads: {
          openThread: {
            threadId: null,
            isTyping: false,
            newThreadEditor: true
          }
        },
        spotlightUserSessionId: null,
        explodeFactor: 0,
        filters: {
          isolatedObjectIds: data.filters?.isolatedIds || [],
          hiddenObjectIds: data.filters?.hiddenIds || [],
          selectedObjectApplicationIds: {},
          propertyFilters: [
            {
              key: data.filters?.propertyInfoKey || null,
              isApplied: true,
              id: 'legacy-filter',
              selectedValues: [],
              condition: 'is'
            }
          ],
          activeColorFilterId: null,
          filterLogic: 'all'
        },
        camera: {
          position: [
            data.camPos?.[0] || 0,
            data.camPos?.[1] || 0,
            data.camPos?.[2] || 0
          ],
          target: [data.camPos?.[3] || 0, data.camPos?.[4] || 0, data.camPos?.[5] || 0],
          isOrthoProjection: !!data.camPos?.[6],
          zoom: data.camPos?.[7] || 1,
          direction: null,
          upVector: [0, 1, 0],
          fieldOfView: 60,
          viewToWorldScale: null
        },
        bcf: {
          clippingPlanes: [],
          defaultVisibility: true,
          visibilityExceptions: [],
          coloring: []
        },
        viewMode: {
          mode: 0,
          edgesColor: 0,
          edgesEnabled: true,
          outlineOpacity: 0.75,
          edgesWeight: 1
        },
        sectionBox: sectionBox
          ? {
              min: (sectionBox.min as number[]) || [0, 0, 0],
              max: (sectionBox.max as number[]) || [0, 0, 0],
              rotation: (sectionBox.rotation as number[]) || [1, 0, 0, 0, 1, 0, 0, 0, 1]
            }
          : null,
        lightConfig: {},
        selection: data.location
          ? [
              data.location.x as number,
              data.location.y as number,
              data.location.z as number
            ]
          : null,
        diff: {
          command: null,
          mode: 1,
          time: 0.5
        },
        measurement: {
          enabled: false,
          options: null,
          measurements: []
        }
      }
    }
    return ret
  }

/**
 * BCF Viewpoint <-> stored SerializedViewerState conversion. Kept independent
 * of generated GraphQL types (plain structural interfaces) since this is a
 * pure data-shape concern, not an API-layer one.
 */

type Vec3 = { x: number; y: number; z: number }

export interface ViewpointInputData {
  isOrthogonal?: boolean | null
  cameraViewPoint?: Vec3 | null
  cameraDirection?: Vec3 | null
  cameraUpVector?: Vec3 | null
  fieldOfView?: number | null
  viewToWorldScale?: number | null
  clippingPlanes?: Array<{ location: Vec3; direction: Vec3 }> | null
  defaultVisibility?: boolean | null
  selection?: string[] | null
  visibilityExceptions?: string[] | null
  coloring?: Array<{ ifcGuid: string; color: string }> | null
}

export interface ViewpointOutput {
  isOrthogonal: boolean
  cameraViewPoint: Vec3 | null
  cameraDirection: Vec3 | null
  cameraUpVector: Vec3 | null
  fieldOfView: number | null
  viewToWorldScale: number | null
  clippingPlanes: Array<{ location: Vec3; direction: Vec3 }>
  defaultVisibility: boolean
  selection: string[]
  visibilityExceptions: string[]
  coloring: Array<{ ifcGuid: string; color: string }>
  snapshot: string | null
}

const vec3ToArray = (v?: Vec3 | null): number[] | null => (v ? [v.x, v.y, v.z] : null)
const arrayToVec3 = (a?: number[] | null): Vec3 | null =>
  a && a.length === 3 ? { x: a[0], y: a[1], z: a[2] } : null

/**
 * Converts a narrow BCF ViewpointInput into a partial SerializedViewerState.
 * BCF stores position+direction; Speckle stores position+target, so a
 * synthetic target is derived along the direction when both are present --
 * only the angle matters for view restoration, not the exact distance.
 */
export function viewpointInputToPartialState(
  viewpoint: ViewpointInputData,
  context: { projectId: string; resourceIdString: string }
): PartialDeep<SerializedViewerState> {
  const position = vec3ToArray(viewpoint.cameraViewPoint)
  const direction = vec3ToArray(viewpoint.cameraDirection)
  const target =
    position && direction
      ? [
          position[0] + direction[0] * 10,
          position[1] + direction[1] * 10,
          position[2] + direction[2] * 10
        ]
      : position || [0, 0, 0]

  return {
    projectId: context.projectId,
    sessionId: 'viewpoint-input',
    viewer: { metadata: { filteringState: null } },
    resources: {
      request: { resourceIdString: context.resourceIdString, threadFilters: {} }
    },
    ui: {
      camera: {
        position: position || [0, 0, 0],
        target,
        isOrthoProjection: viewpoint.isOrthogonal || false,
        direction,
        upVector: vec3ToArray(viewpoint.cameraUpVector),
        fieldOfView: viewpoint.fieldOfView ?? undefined,
        viewToWorldScale: viewpoint.viewToWorldScale ?? undefined
      },
      bcf: {
        clippingPlanes: (viewpoint.clippingPlanes || []).map((p) => ({
          location: vec3ToArray(p.location) || [0, 0, 0],
          direction: vec3ToArray(p.direction) || [0, 0, 0]
        })),
        defaultVisibility: viewpoint.defaultVisibility ?? true,
        visibilityExceptions: viewpoint.visibilityExceptions || [],
        coloring: viewpoint.coloring || []
      },
      filters: {
        selectedObjectApplicationIds: Object.fromEntries(
          (viewpoint.selection || []).map((id) => [id, id])
        )
      }
    }
  }
}

/**
 * Combines an optional full SerializedViewerState with an optional narrow
 * BCF ViewpointInput into the partial state to persist. `viewerState` wins
 * for the base shape when both are given; `viewpoint`'s fields overlay on
 * top of it. Returns null when neither carries usable data.
 */
export function combineViewerStateInputs(params: {
  viewerState?: unknown
  viewpoint?: ViewpointInputData | null
  projectId: string
  resourceIdString: string
}): PartialDeep<SerializedViewerState> | null {
  const { viewerState, viewpoint, projectId, resourceIdString } = params
  const hasViewerState = isSerializedViewerState(viewerState)
  const hasViewpointCamera = !!viewpoint?.cameraViewPoint

  if (!hasViewerState && !hasViewpointCamera) return null

  const base: PartialDeep<SerializedViewerState> = hasViewerState
    ? (viewerState as PartialDeep<SerializedViewerState>)
    : viewpointInputToPartialState(viewpoint!, { projectId, resourceIdString })

  if (!viewpoint || !hasViewerState) return base

  const overlay = viewpointInputToPartialState(viewpoint, {
    projectId,
    resourceIdString
  })

  return {
    ...base,
    ui: {
      ...base.ui,
      camera: { ...base.ui?.camera, ...overlay.ui?.camera },
      bcf: { ...base.ui?.bcf, ...overlay.ui?.bcf },
      filters: {
        ...base.ui?.filters,
        selectedObjectApplicationIds: viewpoint.selection?.length
          ? overlay.ui?.filters?.selectedObjectApplicationIds
          : base.ui?.filters?.selectedObjectApplicationIds
      }
    }
  }
}

/**
 * Maps a formatted SerializedViewerState (plus the entity's own screenshot)
 * into the public BCF Viewpoint shape. Returns null if there's no state at
 * all -- a Topic/Comment without a captured viewpoint is valid in BCF.
 */
export function stateToViewpoint(
  state: SerializedViewerState | null,
  screenshot: string | null
): ViewpointOutput | null {
  if (!state) return null
  return {
    isOrthogonal: state.ui.camera.isOrthoProjection,
    cameraViewPoint: arrayToVec3(state.ui.camera.position),
    cameraDirection: arrayToVec3(state.ui.camera.direction),
    cameraUpVector: arrayToVec3(state.ui.camera.upVector),
    fieldOfView: state.ui.camera.fieldOfView,
    viewToWorldScale: state.ui.camera.viewToWorldScale,
    clippingPlanes: state.ui.bcf.clippingPlanes.map((p) => ({
      location: arrayToVec3(p.location) || { x: 0, y: 0, z: 0 },
      direction: arrayToVec3(p.direction) || { x: 0, y: 0, z: 0 }
    })),
    defaultVisibility: state.ui.bcf.defaultVisibility,
    selection: Object.keys(state.ui.filters.selectedObjectApplicationIds),
    visibilityExceptions: state.ui.bcf.visibilityExceptions,
    coloring: state.ui.bcf.coloring,
    snapshot: screenshot
  }
}
