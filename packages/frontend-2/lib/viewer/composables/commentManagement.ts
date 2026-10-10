import type { ApolloCache } from '@apollo/client/cache'
import type { JSONContent } from '@tiptap/core'
import { useApolloClient, useQuery, useSubscription } from '@vue/apollo-composable'
import type { MaybeRef } from '@vueuse/core'
import dayjs from 'dayjs'
import type { Get } from 'type-fest'
import { useActiveUser } from '~~/lib/auth/composables/activeUser'
import type {
  CommentContentInput,
  CreateCommentInput,
  DocumentReferenceInput,
  OnViewerCommentsUpdatedSubscription,
  ViewerResourceItem
} from '~~/lib/common/generated/gql/graphql'
import {
  convertThrowIntoFetchResult,
  getCacheId,
  getFirstErrorMessage
} from '~~/lib/common/helpers/graphql'
import {
  createCommentReplyMutation,
  createCommentThreadMutation,
  createViewpointMutation,
  markCommentViewedMutation,
  updateTopicMutation
} from '~~/lib/viewer/graphql/mutations'
import { projectTopicOptionsQuery } from '~~/lib/viewer/graphql/queries'
import { onViewerCommentsUpdatedSubscription } from '~~/lib/viewer/graphql/subscriptions'
import {
  useInjectedViewerState,
  type LoadedCommentThread
} from '~~/lib/viewer/composables/setup'
import type { MaybeNullOrUndefined, SpeckleViewer } from '@speckle/shared'
import { ToastNotificationType, useGlobalToast } from '~~/lib/common/composables/toast'
import type { SuccessfullyUploadedFileItem } from '~~/lib/core/api/blobStorage'
import { isValidCommentContentInput } from '~~/lib/viewer/helpers/comments'
import {
  useStateSerialization,
  useApplySerializedState,
  StateApplyMode
} from '~~/lib/viewer/composables/serialization'
import type { CommentBubbleModel } from '~/lib/viewer/composables/commentBubbles'
import { graphql } from '~/lib/common/generated/gql'

export function useViewerCommentUpdateTracking(
  params: {
    projectId: MaybeRef<string>
    resourceIdString: MaybeRef<string>
    loadedVersionsOnly?: MaybeRef<MaybeNullOrUndefined<boolean>>
  },
  handler?: (
    data: NonNullable<
      Get<OnViewerCommentsUpdatedSubscription, 'projectCommentsUpdated'>
    >,
    cache: ApolloCache<unknown>
  ) => void
) {
  const apollo = useApolloClient().client
  const { onResult: onViewerCommentUpdated } = useSubscription(
    onViewerCommentsUpdatedSubscription,
    () => ({
      target: {
        projectId: unref(params.projectId),
        resourceIdString: unref(params.resourceIdString),
        loadedVersionsOnly: unref(params.loadedVersionsOnly)
      }
    }),
    () => ({
      errorPolicy: 'all'
    })
  )

  onViewerCommentUpdated((res) => {
    if (!res.data?.projectCommentsUpdated) return

    const event = res.data.projectCommentsUpdated
    const cache = apollo.cache

    handler?.(event, cache)
  })
}

export function useMarkThreadViewed() {
  const apollo = useApolloClient().client
  const { isLoggedIn } = useActiveUser()
  const logger = useLogger()

  return async (projectId: string, threadId: string) => {
    if (!isLoggedIn.value) return false
    const { data, errors } = await apollo
      .mutate({
        mutation: markCommentViewedMutation,
        variables: {
          input: {
            projectId,
            topicId: threadId
          }
        },
        update: (cache, { data }) => {
          if (!data?.topicMutations.markViewed) return

          cache.modify({
            id: getCacheId('Topic', threadId),
            fields: {
              viewedAt: () => dayjs().toISOString()
            }
          })
        }
      })
      .catch(convertThrowIntoFetchResult)

    if (errors) {
      logger.error('Marking thread as viewed failed', errors)
    }

    return !!data?.topicMutations.markViewed
  }
}

export type CommentEditorValue = {
  doc?: JSONContent | null
  attachments?: SuccessfullyUploadedFileItem[] | null
}

export type BcfTopicProperties = {
  topicType?: MaybeNullOrUndefined<string>
  topicStatus?: MaybeNullOrUndefined<string>
  priority?: MaybeNullOrUndefined<string>
  stage?: MaybeNullOrUndefined<string>
  title?: MaybeNullOrUndefined<string>
  labels?: MaybeNullOrUndefined<string[]>
  referenceLinks?: MaybeNullOrUndefined<string[]>
  dueDate?: MaybeNullOrUndefined<string>
  assignedTo?: MaybeNullOrUndefined<string>
  relatedTopicIds?: MaybeNullOrUndefined<string[]>
  documentReferences?: MaybeNullOrUndefined<DocumentReferenceInput[]>
}

export function useSubmitComment() {
  const {
    projectId,
    resources: {
      request: { resourceIdString }
    },
    viewer: { instance: viewerInstance }
  } = useInjectedViewerState()
  const { isLoggedIn } = useActiveUser()
  const client = useApolloClient().client
  const { triggerNotification } = useGlobalToast()
  const { serialize } = useStateSerialization()

  return async (content: CommentContentInput, bcfFields?: BcfTopicProperties) => {
    if (!isLoggedIn.value) return null
    if (!isValidCommentContentInput(content)) return null
    const screenshot = await viewerInstance.screenshot()

    const { data, errors } = await client
      .mutate({
        mutation: createCommentThreadMutation,
        variables: {
          input: {
            projectId: projectId.value,
            resourceIdString: resourceIdString.value,
            content,
            viewerState: serialize({ concreteResourceIdString: true }),
            screenshot,
            ...bcfFields
          }
        }
      })
      .catch(convertThrowIntoFetchResult)

    if (data?.topicMutations.create) {
      return data.topicMutations.create
    }

    const errMsg = getFirstErrorMessage(errors)
    triggerNotification({
      type: ToastNotificationType.Danger,
      title: 'Comment creation failed',
      description: errMsg
    })

    return null
  }
}

export function useUpdateTopic() {
  const { projectId } = useInjectedViewerState()
  const { isLoggedIn } = useActiveUser()
  const client = useApolloClient().client
  const { triggerNotification } = useGlobalToast()

  return async (topicId: string, bcfFields: BcfTopicProperties) => {
    if (!isLoggedIn.value) return null

    const { data, errors } = await client
      .mutate({
        mutation: updateTopicMutation,
        variables: {
          input: {
            topicId,
            projectId: projectId.value,
            ...bcfFields
          }
        }
      })
      .catch(convertThrowIntoFetchResult)

    if (data?.topicMutations.update) {
      return data.topicMutations.update
    }

    const errMsg = getFirstErrorMessage(errors)
    triggerNotification({
      type: ToastNotificationType.Danger,
      title: 'Topic update failed',
      description: errMsg
    })

    return null
  }
}

/**
 * Saves the viewer's CURRENT camera/selection/clipping state as a new,
 * independently-addressable viewpoint on an existing topic -- additional to
 * (not replacing) the topic's own original creation-time viewpoint. Mirrors
 * useSubmitComment()'s screenshot/serialize pattern.
 */
export function useCreateViewpoint() {
  const {
    projectId,
    viewer: { instance: viewerInstance }
  } = useInjectedViewerState()
  const { isLoggedIn } = useActiveUser()
  const client = useApolloClient().client
  const { triggerNotification } = useGlobalToast()
  const { serialize } = useStateSerialization()

  return async (topicId: string) => {
    if (!isLoggedIn.value) return null
    const screenshot = await viewerInstance.screenshot()

    const { data, errors } = await client
      .mutate({
        mutation: createViewpointMutation,
        variables: {
          input: {
            topicId,
            projectId: projectId.value,
            viewerState: serialize({ concreteResourceIdString: true }),
            screenshot
          }
        }
      })
      .catch(convertThrowIntoFetchResult)

    if (data?.topicMutations.createViewpoint) {
      return data.topicMutations.createViewpoint
    }

    const errMsg = getFirstErrorMessage(errors)
    triggerNotification({
      type: ToastNotificationType.Danger,
      title: 'Viewpoint creation failed',
      description: errMsg
    })

    return null
  }
}

/**
 * Lightweight id/title options for every topic in the current project, for
 * a "related topics" picker -- deliberately not the full ViewerCommentThread
 * fragment already loaded elsewhere, since a picker only needs enough to
 * label each option.
 */
export function useProjectTopicOptions() {
  const { projectId } = useInjectedViewerState()
  const { result } = useQuery(projectTopicOptionsQuery, () => ({
    projectId: projectId.value
  }))

  const topicOptions = computed(() => result.value?.project?.topics.items ?? [])

  return { topicOptions }
}

export function useSubmitReply() {
  const { isLoggedIn } = useActiveUser()
  const client = useApolloClient().client
  const { triggerNotification } = useGlobalToast()

  return async (input: CreateCommentInput) => {
    if (!isLoggedIn.value) return null
    if (!isValidCommentContentInput(input.content)) return null

    const { data, errors } = await client
      .mutate({
        mutation: createCommentReplyMutation,
        variables: {
          input
        }
      })
      .catch(convertThrowIntoFetchResult)

    if (data?.topicMutations.comment) {
      return data.topicMutations.comment
    }

    const errMsg = getFirstErrorMessage(errors)
    triggerNotification({
      type: ToastNotificationType.Danger,
      title: 'Reply creation failed',
      description: errMsg
    })

    return null
  }
}

graphql(`
  fragment UseCheckViewerCommentingAccess_Project on Project {
    id
    permissions {
      canCreateComment {
        ...FullPermissionCheckResult
      }
    }
  }
`)

export function useCheckViewerCommentingAccess() {
  const {
    resources: {
      response: { project }
    }
  } = useInjectedViewerState()

  return computed(() => {
    return project.value?.permissions.canCreateComment.authorized
  })
}

const useActiveThreadContext = () => {
  type ThreadContext = {
    threadId: string | null
    previousState: SpeckleViewer.ViewerState.SerializedViewerState | null
  }
  return useState<ThreadContext>('thread-context', () => ({
    threadId: null,
    previousState: null
  }))
}

export const useCommentContext = () => {
  const applyState = useApplySerializedState()
  const { serialize } = useStateSerialization()
  const state = useInjectedViewerState()
  const threadContext = useActiveThreadContext()

  const thread = computed(() => state.ui.threads.openThread.thread.value)

  const calculateThreadResourceStatus = (
    threadData: LoadedCommentThread | CommentBubbleModel | null | undefined
  ) => {
    if (!threadData) return { isLoaded: false }
    const loadedResources = state.resources.response.resourceItems.value
    const resourceLinks = threadData?.resources

    if (!resourceLinks) {
      return { isLoaded: false }
    }

    // Check if any of the thread's objects are loaded
    const objectLinks = resourceLinks
      .filter((l) => l.resourceType === 'object')
      .map((l) => l.resourceId)
    const commitLinks = resourceLinks
      .filter((l) => l.resourceType === 'commit')
      .map((l) => l.resourceId)

    // Check if ALL of the thread's objects are loaded
    const hasLoadedObjects =
      objectLinks.length > 0 &&
      objectLinks.every((objId) => loadedResources.some((lr) => lr.objectId === objId))

    // Check if ALL of the thread's commits are loaded
    const hasLoadedVersions =
      commitLinks.length > 0 &&
      commitLinks.every((commitId) =>
        loadedResources.some((lr) => lr.versionId && lr.versionId === commitId)
      )

    // Resource is loaded, check versions and federation
    const currentModels = state.resources.response.modelsAndVersionIds.value
    const threadModels = threadData.viewerResources.filter(
      (r): r is ViewerResourceItem & { modelId: string; versionId: string } =>
        r.modelId !== null && r.versionId !== null
    )

    // Check if any thread models are not in current view (federated)
    const hasFederatedModels = threadModels.some(
      (threadModel) => !currentModels.some((m) => m.model.id === threadModel.modelId)
    )

    // For models that exist in both states, check version differences
    const hasDifferentVersions = threadModels.some((threadModel) => {
      const currentModel = currentModels.find((m) => m.model.id === threadModel.modelId)
      return currentModel && currentModel.versionId !== threadModel.versionId
    })

    return {
      isLoaded: hasLoadedObjects || hasLoadedVersions,
      isDifferentVersion: hasDifferentVersions,
      isFederatedModel: hasFederatedModels
    }
  }

  const threadResourceStatus = computed(() =>
    calculateThreadResourceStatus(thread.value)
  )

  const hasClickedFullContext = computed(() => {
    const threadId = thread.value?.id
    return threadContext.value.threadId === threadId
  })

  const loadContext = async (
    mode: StateApplyMode.ThreadFullContextOpen | StateApplyMode.FederatedContext
  ) => {
    const state = thread.value?.viewerState
    const threadId = thread.value?.id ?? null
    if (!state) return

    // Store both current state and thread ID
    threadContext.value = {
      threadId,
      previousState: serialize()
    }

    await applyState(state, mode)
  }

  const loadThreadVersionContext = () =>
    loadContext(StateApplyMode.ThreadFullContextOpen)
  const loadFederatedContext = () => loadContext(StateApplyMode.FederatedContext)

  const handleContextClick = () => {
    if (threadResourceStatus.value.isDifferentVersion) {
      loadThreadVersionContext()
    } else {
      loadFederatedContext()
    }
  }

  const goBack = async () => {
    if (!threadContext.value.previousState) {
      return
    }

    await applyState(
      threadContext.value.previousState,
      StateApplyMode.ThreadFullContextOpen
    )
    threadContext.value = {
      threadId: null,
      previousState: null
    }
  }

  const cleanupThreadContext = () => {
    threadContext.value = {
      threadId: null,
      previousState: null
    }
  }

  return {
    threadResourceStatus,
    calculateThreadResourceStatus,
    handleContextClick,
    goBack,
    hasClickedFullContext,
    cleanupThreadContext
  }
}
