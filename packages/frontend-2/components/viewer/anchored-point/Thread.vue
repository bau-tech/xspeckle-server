<template>
  <div class="relative">
    <div
      class="absolute pointer-events-auto"
      :style="{
        ...modelValue.style,
        opacity: 1
      }"
    >
      <div ref="threadActivator" class="relative">
        <button
          :class="`
        ${modelValue.isOccluded && !isExpanded ? 'opacity-60 hover:opacity-100' : ''}
        ${isExpanded ? 'outline outline-2 outline-primary' : ''}
        transition bg-foundation shadow hover:shadow-xl flex -space-x-2 items-center p-[2px] rounded-tr-full rounded-tl-full rounded-br-full`"
          @click="onThreadClick"
        >
          <UserAvatarGroup hide-tooltips :users="threadAuthors" />
        </button>
      </div>
    </div>
    <div
      v-if="isExpanded"
      ref="threadContainer"
      class="thread-container fixed mb-16 bottom-0 right-0 sm:bottom-auto sm:right-auto w-screen sm:w-80 z-50 pointer-events-auto"
      :style="threadStyle"
    >
      <ViewerCommentsPortalOrDiv to="mobileComments">
        <div
          class="relative bg-foundation border border-outline-2 flex flex-col overflow-hidden sm:shadow-md cursor-auto sm:rounded-lg h-full transition-all duration-200"
          :class="{ 'is-dragging border-outline-5': isDragging }"
        >
          <div
            ref="handle"
            class="relative w-full flex justify-between items-center border-b border-outline-2 p-2 pb-1.5 cursor-move"
          >
            <div class="flex-grow flex items-center gap-x-1">
              <div class="flex items-center gap-x-0.5">
                <FormButton
                  :icon-left="ChevronLeft"
                  color="outline"
                  hide-text
                  size="sm"
                  :disabled="!hasPrevious"
                  @click="emit('prev', modelValue)"
                />
                <FormButton
                  :icon-left="ChevronRight"
                  color="outline"
                  hide-text
                  size="sm"
                  :disabled="!hasNext"
                  @click="emit('next', modelValue)"
                />
              </div>
            </div>
            <div class="flex gap-x-0.5">
              <div class="cursor-pointer">
                <LayoutMenu
                  v-model:open="showMenu"
                  :menu-id="menuId"
                  :items="actionsItems"
                  mount-menu-on-body
                  @click.stop.prevent
                  @chosen="onActionChosen"
                >
                  <FormButton
                    hide-text
                    size="sm"
                    color="subtle"
                    :class="showMenu ? '!bg-highlight-3' : ''"
                    :icon-left="Ellipsis"
                    @click="showMenu = !showMenu"
                  />
                </LayoutMenu>
              </div>
              <FormButton
                :icon-left="X"
                hide-text
                color="subtle"
                size="sm"
                @click="changeExpanded(false)"
              />
            </div>
          </div>
          <div class="grid grid-cols-2 gap-1 border-b border-outline-2 p-2">
            <ViewerCommentsBcfPropertySelect
              :model-value="topicType"
              :items="BCF_TOPIC_TYPES"
              label="Type"
              name="thread-topic-type"
              @update:model-value="onTopicTypeChanged"
            />
            <ViewerCommentsBcfPropertySelect
              :model-value="topicStatus"
              :items="BCF_TOPIC_STATUSES"
              label="Status"
              name="thread-topic-status"
              @update:model-value="onTopicStatusChanged"
            />
            <ViewerCommentsBcfPropertySelect
              :model-value="priority"
              :items="BCF_PRIORITIES"
              label="Priority"
              name="thread-priority"
              @update:model-value="onPriorityChanged"
            />
            <FormTextInput
              :model-value="stage ?? undefined"
              name="thread-stage"
              label="Stage"
              placeholder="Stage"
              size="sm"
              @change="onStageChanged"
            />
          </div>
          <div
            class="flex items-center gap-x-1 overflow-x-auto border-b border-outline-2 p-2 simple-scrollbar"
          >
            <button
              v-for="item in viewpointGalleryItems"
              :key="item.key"
              v-tippy="item.isOriginal ? 'Original viewpoint' : 'Saved viewpoint'"
              type="button"
              class="relative shrink-0 w-[84px] h-[60px] rounded overflow-hidden border border-outline-2 hover:border-primary transition"
              @click="onRestoreViewpoint(item.viewerState)"
            >
              <img
                :src="item.snapshot ?? undefined"
                class="w-full h-full object-cover"
                alt="Viewpoint snapshot"
              />
            </button>
            <FormButton
              v-tippy="'Save current view as a viewpoint'"
              :icon-left="Camera"
              hide-text
              color="subtle"
              size="sm"
              :loading="isSavingViewpoint"
              @click="onSaveViewpoint"
            />
          </div>
          <div class="border-b border-outline-2 p-2">
            <button
              type="button"
              class="text-body-2xs text-foreground-2 hover:text-foreground font-medium"
              @click="showMoreDetails = !showMoreDetails"
            >
              {{ showMoreDetails ? 'Hide details' : 'More details' }}
            </button>
            <div v-if="showMoreDetails" class="flex flex-col gap-y-2 mt-2">
              <FormTextInput
                :model-value="title ?? undefined"
                name="thread-title"
                label="Title"
                placeholder="Title"
                size="sm"
                @change="onTitleChanged"
              />
              <FormTags
                :model-value="labels"
                name="thread-labels"
                label="Labels"
                placeholder="Add a label"
                size="sm"
                @update:model-value="onLabelsChanged"
              />
              <FormTags
                :model-value="referenceLinks"
                name="thread-reference-links"
                label="Reference links"
                placeholder="Add a link"
                size="sm"
                @update:model-value="onReferenceLinksChanged"
              />
              <FormTextInput
                :model-value="dueDate ?? undefined"
                type="date"
                name="thread-due-date"
                label="Due date"
                size="sm"
                :custom-icon="CalendarIcon"
                @change="onDueDateChanged"
              />
              <FormTextInput
                :model-value="assignedTo ?? undefined"
                name="thread-assigned-to"
                label="Assigned to"
                placeholder="Assigned to"
                size="sm"
                @change="onAssignedToChanged"
              />
              <FormSelectBase
                :model-value="
                  relatedTopicOptions.filter((o) => relatedTopicIds.includes(o.id))
                "
                :items="relatedTopicOptions"
                by="id"
                multiple
                name="thread-related-topics"
                label="Related topics"
                placeholder="Related topics"
                size="sm"
                @update:model-value="onRelatedTopicsSelectionChanged"
              >
                <template #something-selected="{ value }">
                  <span class="truncate">
                    {{
                      (Array.isArray(value) ? value : [value])
                        .map(topicOptionLabel)
                        .join(', ')
                    }}
                  </span>
                </template>
                <template #option="{ item }">
                  <span class="truncate">{{ topicOptionLabel(item) }}</span>
                </template>
              </FormSelectBase>
              <div class="flex flex-col gap-y-1">
                <div class="text-body-3xs text-foreground-2 font-medium">
                  Document references
                </div>
                <div
                  v-for="(doc, index) in documentReferences"
                  :key="index"
                  class="flex gap-x-1 items-start"
                >
                  <FormTextInput
                    :model-value="doc.url ?? undefined"
                    :name="`thread-doc-url-${index}`"
                    placeholder="URL"
                    size="sm"
                    class="flex-1"
                    @change="(payload) => onDocumentReferenceUrlChanged(index, payload)"
                  />
                  <FormTextInput
                    :model-value="doc.description ?? undefined"
                    :name="`thread-doc-desc-${index}`"
                    placeholder="Description"
                    size="sm"
                    class="flex-1"
                    @change="
                      (payload) => onDocumentReferenceDescriptionChanged(index, payload)
                    "
                  />
                  <FormButton
                    :icon-left="X"
                    hide-text
                    color="subtle"
                    size="sm"
                    @click="removeDocumentReference(index)"
                  />
                </div>
                <FormButton size="sm" color="subtle" @click="addDocumentReference">
                  + Add reference
                </FormButton>
              </div>
              <div v-if="bcfAuthorship" class="text-body-3xs text-foreground-2">
                {{ bcfAuthorship }}
              </div>
            </div>
          </div>
          <div
            v-if="showBanner"
            class="flex items-center justify-between gap-4 border-b border-outline-2 py-2 px-2 w-full"
          >
            <div class="text-body-2xs text-foreground-2 font-medium">
              {{ bannerText }}
            </div>
            <FormButton
              :icon-right="bannerButton.icon"
              size="sm"
              color="outline"
              @click="bannerButton.action"
            >
              {{ bannerButton.text }}
            </FormButton>
          </div>
          <div class="relative w-full sm:w-80 flex flex-col flex-1 justify-between">
            <div
              ref="commentsContainer"
              class="max-h-[200px] sm:max-h-[300px] 2xl:max-h-[500px] overflow-y-auto simple-scrollbar flex flex-col px-2 py-1"
            >
              <ViewerAnchoredPointThreadComment
                v-for="comment in comments"
                :key="comment.id"
                :comment="comment"
                :project-id="projectId"
                @mounted="onCommentMounted"
              />
            </div>
            <div
              v-if="isTypingMessage"
              class="w-full px-3 md:px-4 pb-3 caption mt-1 text-body-2xs"
            >
              {{ isTypingMessage }}
            </div>
          </div>
          <ViewerAnchoredPointThreadNewReply
            v-if="showNewReplyComponent"
            :model-value="modelValue"
            @submit="onNewReply"
          />
          <div
            v-if="isEmbedEnabled"
            class="flex justify-between w-full p-2 border-t border-outline-2"
          >
            <FormButton
              full-width
              :to="getLinkToThread(projectId, props.modelValue)"
              external
              target="_blank"
              size="sm"
              color="outline"
            >
              Reply in Speckle
            </FormButton>
          </div>
          <div
            v-if="!canReply && !isEmbedEnabled && !isLoggedIn"
            class="flex justify-between w-full p-2 border-t border-outline-2"
          >
            <FormButton full-width color="outline" size="sm" @click="$emit('login')">
              Reply
            </FormButton>
          </div>
        </div>
      </ViewerCommentsPortalOrDiv>
    </div>
    <LayoutDialog
      v-model:open="confirmDelete"
      max-width="sm"
      :buttons="deleteButtons"
    >
      <template #header>Delete topic</template>
      <p class="text-body-xs text-foreground">
        Delete
        <span class="font-medium">{{ modelValue.title || 'this topic' }}</span>
        with all its comments and viewpoints? This cannot be undone. A BCF server this
        model syncs with deletes it too.
      </p>
    </LayoutDialog>
  </div>
</template>
<script setup lang="ts">
import {
  MoveLeft,
  MoveRight,
  X,
  ChevronLeft,
  ChevronRight,
  Ellipsis,
  Calendar as CalendarIcon,
  Camera
} from 'lucide-vue-next'
import { ensureError, SpeckleViewer } from '@speckle/shared'
import type { Nullable } from '@speckle/shared'
import { onKeyDown, useClipboard, useDraggable, onClickOutside } from '@vueuse/core'
import { scrollToBottom } from '~~/lib/common/helpers/dom'
import { useViewerThreadTypingTracking } from '~~/lib/viewer/composables/activity'
import { useAnimatingEllipsis } from '~~/lib/viewer/composables/commentBubbles'
import type { CommentBubbleModel } from '~~/lib/viewer/composables/commentBubbles'
import {
  useCheckViewerCommentingAccess,
  useMarkThreadViewed,
  useCommentContext,
  useUpdateTopic,
  useDeleteTopic,
  useProjectTopicOptions,
  useCreateViewpoint
} from '~~/lib/viewer/composables/commentManagement'
import {
  useApplySerializedState,
  StateApplyMode
} from '~~/lib/viewer/composables/serialization'
import type { DocumentReferenceInput } from '~~/lib/common/generated/gql/graphql'
import {
  BCF_TOPIC_TYPES,
  BCF_TOPIC_STATUSES,
  BCF_PRIORITIES,
  toBcfDueDateInput,
  fromBcfDueDate
} from '~~/lib/viewer/helpers/bcf'
import { useInjectedViewerState } from '~~/lib/viewer/composables/setup'
import { useActiveUser } from '~~/lib/auth/composables/activeUser'
import { ToastNotificationType, useGlobalToast } from '~~/lib/common/composables/toast'
import { getLinkToThread } from '~~/lib/viewer/helpers/comments'
import { useDisableGlobalTextSelection } from '~~/lib/common/composables/window'
import { useMixpanel } from '~~/lib/core/composables/mp'
import { useThreadUtilities } from '~~/lib/viewer/composables/ui'
import { useEmbed } from '~/lib/viewer/composables/setup/embed'
import { graphql } from '~/lib/common/generated/gql'
import type { LayoutMenuItem } from '~~/lib/layout/helpers/components'
import type { LayoutDialogButton } from '@speckle/ui-components'

enum ActionTypes {
  CopyLink = 'copy-link',
  PopIn = 'pop-in',
  CloseTopic = 'close-topic',
  ReopenTopic = 'reopen-topic',
  DeleteTopic = 'delete-topic'
}

graphql(`
  fragment ViewerCommentThreadData on Topic {
    id
    topicType
    topicStatus
    priority
    stage
    title
    labels
    dueDate
    assignedTo
    relatedTopics {
      id
      title
      rawText
    }
    documentReferences {
      id
      guid
      documentGuid
      url
      description
    }
    guid
    creationAuthor
    modifiedAuthor
    modifiedDate
    referenceLinks
    screenshot
    viewpoints {
      id
      guid
      index
      snapshot
      viewerState
    }
  }
`)

const emit = defineEmits<{
  (e: 'update:modelValue', v: CommentBubbleModel): void
  (e: 'update:expanded', v: boolean): void
  (e: 'next', v: CommentBubbleModel): void
  (e: 'prev', v: CommentBubbleModel): void
  (e: 'login'): void
}>()

const props = defineProps<{
  modelValue: CommentBubbleModel
  hasPrevious?: boolean
  hasNext?: boolean
}>()

const { isEmbedEnabled } = useEmbed()

const threadId = computed(() => props.modelValue.id)
const { copy } = useClipboard()
const { isLoggedIn } = useActiveUser()
const { triggerNotification } = useGlobalToast()
const { projectId } = useInjectedViewerState()
const canReply = useCheckViewerCommentingAccess()
const { disableTextSelection } = useDisableGlobalTextSelection()
const markThreadViewed = useMarkThreadViewed()
const { usersTyping } = useViewerThreadTypingTracking(threadId)
const { ellipsis, controls } = useAnimatingEllipsis()
const { threadResourceStatus, hasClickedFullContext, goBack, handleContextClick } =
  useCommentContext()
const { isOpenThread, open, closeAllThreads } = useThreadUtilities()
const menuId = useId()
const updateTopic = useUpdateTopic()
const deleteTopic = useDeleteTopic()
const confirmDelete = ref(false)
const isDeleting = ref(false)
const createViewpoint = useCreateViewpoint()
const applyState = useApplySerializedState()

const showMenu = ref(false)
const commentsContainer = ref(null as Nullable<HTMLElement>)
const threadContainer = ref(null as Nullable<HTMLElement>)
const threadActivator = ref(null as Nullable<HTMLElement>)

const topicType = ref(props.modelValue.topicType ?? null)
const topicStatus = ref(props.modelValue.topicStatus ?? null)
const priority = ref(props.modelValue.priority ?? null)
const stage = ref(props.modelValue.stage ?? null)
const title = ref(props.modelValue.title ?? null)
const dueDate = ref(fromBcfDueDate(props.modelValue.dueDate))
const assignedTo = ref(props.modelValue.assignedTo ?? null)
const labels = ref<string[]>(props.modelValue.labels ?? [])
const referenceLinks = ref<string[]>(props.modelValue.referenceLinks ?? [])
const relatedTopicIds = ref<string[]>(
  (props.modelValue.relatedTopics ?? []).map((t) => t.id)
)
const documentReferences = ref<DocumentReferenceInput[]>(
  (props.modelValue.documentReferences ?? []).map((d) => ({
    guid: d.guid,
    documentGuid: d.documentGuid,
    url: d.url,
    description: d.description
  }))
)
const showMoreDetails = ref(false)

// Viewpoints created via onSaveViewpoint this session -- kept separate from
// props.modelValue.viewpoints (the server/cache-sourced list) rather than
// trying to splice the mutation result into the Apollo cache, and merged
// with it purely for display via viewpointGalleryItems below. Cleared
// whenever the displayed thread changes, same as the other local refs.
const newlyCreatedViewpoints = ref<
  Array<{
    id?: Nullable<string>
    guid?: Nullable<string>
    snapshot?: Nullable<string>
    viewerState?: unknown
  }>
>([])
const isSavingViewpoint = ref(false)

// The viewer's own capture (viewerInstance.screenshot(), used by
// useSubmitComment/useCreateViewpoint) is a full data URI. The external BCF
// server's sync pushes snapshots as bare base64 (no "data:image/png;base64," prefix
// -- stripped because Speckle's CreateCommentInput.screenshot rejects a full
// data URI outright), so a topic pushed from there stores a bare base64
// string in the same `screenshot` column. Normalize both shapes here rather
// than relying on every producer to agree on one.
const normalizeSnapshotSrc = (snapshot: Nullable<string>): Nullable<string> => {
  if (!snapshot) return snapshot
  return snapshot.startsWith('data:') ? snapshot : `data:image/png;base64,${snapshot}`
}

// Topic.viewpoints is the topic's one BCF viewpoint list -- its creation-time
// view is simply the first entry, not a separate field anymore.
const viewpointGalleryItems = computed(() => {
  const items: Array<{
    key: string
    snapshot: Nullable<string>
    viewerState: unknown
    isOriginal: boolean
  }> = []
  const all = [...(props.modelValue.viewpoints ?? []), ...newlyCreatedViewpoints.value]
  all.forEach((vp, i) => {
    if (!vp.snapshot) return
    items.push({
      key: vp.guid ?? vp.id ?? `viewpoint-${i}`,
      snapshot: normalizeSnapshotSrc(vp.snapshot),
      viewerState: vp.viewerState,
      isOriginal: i === 0
    })
  })
  return items
})

const onSaveViewpoint = async () => {
  isSavingViewpoint.value = true
  try {
    const created = await createViewpoint(props.modelValue.id)
    if (created) newlyCreatedViewpoints.value.push(created)
  } finally {
    isSavingViewpoint.value = false
  }
}

const onRestoreViewpoint = async (viewerState: unknown) => {
  if (!SpeckleViewer.ViewerState.isSerializedViewerState(viewerState)) {
    triggerNotification({
      type: ToastNotificationType.Danger,
      title: 'Could not restore viewpoint',
      description: 'This viewpoint has no usable stored view state.'
    })
    return
  }
  await applyState(viewerState, StateApplyMode.ThreadOpen)
}

const { topicOptions } = useProjectTopicOptions()
const relatedTopicOptions = computed(() =>
  topicOptions.value.filter((t) => t.id !== props.modelValue.id)
)
const topicOptionLabel = (t: {
  title?: Nullable<string>
  rawText?: Nullable<string>
}) => t.title || t.rawText || 'Untitled'

watch(
  () => props.modelValue.id,
  () => {
    topicType.value = props.modelValue.topicType ?? null
    topicStatus.value = props.modelValue.topicStatus ?? null
    priority.value = props.modelValue.priority ?? null
    stage.value = props.modelValue.stage ?? null
    title.value = props.modelValue.title ?? null
    dueDate.value = fromBcfDueDate(props.modelValue.dueDate)
    assignedTo.value = props.modelValue.assignedTo ?? null
    labels.value = props.modelValue.labels ?? []
    referenceLinks.value = props.modelValue.referenceLinks ?? []
    relatedTopicIds.value = (props.modelValue.relatedTopics ?? []).map((t) => t.id)
    documentReferences.value = (props.modelValue.documentReferences ?? []).map((d) => ({
      guid: d.guid,
      documentGuid: d.documentGuid,
      url: d.url,
      description: d.description
    }))
    newlyCreatedViewpoints.value = []
  }
)

const persistBcfFields = async () => {
  await updateTopic(props.modelValue.id, {
    topicType: topicType.value,
    topicStatus: topicStatus.value,
    priority: priority.value,
    stage: stage.value,
    title: title.value,
    dueDate: toBcfDueDateInput(dueDate.value),
    assignedTo: assignedTo.value,
    labels: labels.value,
    referenceLinks: referenceLinks.value,
    relatedTopicIds: relatedTopicIds.value,
    documentReferences: documentReferences.value
  })
}

const onReferenceLinksChanged = async (value: string[]) => {
  referenceLinks.value = value
  await persistBcfFields()
}

// BCF identities (emails) of who created / last modified the topic. Differ
// from the Speckle author shown above when the topic came in through a BCF
// sync (e.g. from the external BCF server).
const bcfAuthorship = computed(() => {
  const parts: string[] = []
  if (props.modelValue.creationAuthor) {
    parts.push(`Created by ${props.modelValue.creationAuthor}`)
  }
  if (props.modelValue.modifiedAuthor && props.modelValue.modifiedDate) {
    parts.push(
      `modified by ${props.modelValue.modifiedAuthor} on ${new Date(
        props.modelValue.modifiedDate
      ).toLocaleString()}`
    )
  }
  return parts.join(', ')
})

const onBcfFieldChanged = async (
  field:
    | 'topicType'
    | 'topicStatus'
    | 'priority'
    | 'stage'
    | 'title'
    | 'dueDate'
    | 'assignedTo',
  value: Nullable<string>
) => {
  const fieldRefs = {
    topicType,
    topicStatus,
    priority,
    stage,
    title,
    dueDate,
    assignedTo
  }
  fieldRefs[field].value = value
  await persistBcfFields()
}

const onTopicTypeChanged = (v: Nullable<string>) => onBcfFieldChanged('topicType', v)
const onTopicStatusChanged = (v: Nullable<string>) =>
  onBcfFieldChanged('topicStatus', v)
const onPriorityChanged = (v: Nullable<string>) => onBcfFieldChanged('priority', v)
const onStageChanged = (payload: { value: string }) =>
  onBcfFieldChanged('stage', payload.value || null)
const onTitleChanged = (payload: { value: string }) =>
  onBcfFieldChanged('title', payload.value || null)
const onDueDateChanged = (payload: { value: string }) =>
  onBcfFieldChanged('dueDate', payload.value || null)
const onAssignedToChanged = (payload: { value: string }) =>
  onBcfFieldChanged('assignedTo', payload.value || null)

const onLabelsChanged = async (value: string[]) => {
  labels.value = value
  await persistBcfFields()
}

const onRelatedTopicsChanged = async (value: string[]) => {
  relatedTopicIds.value = value
  await persistBcfFields()
}

const onRelatedTopicsSelectionChanged = (
  selected?: { id: string }[] | { id: string }
) => {
  const items = Array.isArray(selected) ? selected : selected ? [selected] : []
  onRelatedTopicsChanged(items.map((o) => o.id))
}

const addDocumentReference = () => {
  documentReferences.value.push({ url: '', description: '' })
}

const removeDocumentReference = async (index: number) => {
  documentReferences.value.splice(index, 1)
  await persistBcfFields()
}

const onDocumentReferenceUrlChanged = (index: number, payload: { value: string }) => {
  documentReferences.value[index].url = payload.value
  persistBcfFields()
}

const onDocumentReferenceDescriptionChanged = (
  index: number,
  payload: { value: string }
) => {
  documentReferences.value[index].description = payload.value
  persistBcfFields()
}

onClickOutside(threadContainer, (event) => {
  const viewerElement = document.getElementById('viewer')

  if (
    isExpanded.value &&
    viewerElement &&
    (event.target === viewerElement || viewerElement.contains(event.target as Node)) &&
    !(threadActivator.value && threadActivator.value.contains(event.target as Node))
  ) {
    changeExpanded(false)
  }
})

const handle = ref(null as Nullable<HTMLElement>)
const justCreatedReply = ref(false)

const comments = computed(() => [
  props.modelValue,
  ...props.modelValue.comments.items.slice().reverse()
])

const showNewReplyComponent = computed(() => {
  return canReply.value && !isEmbedEnabled.value
})

const isExpanded = computed(() => isOpenThread(props.modelValue.id))

const isTypingMessage = computed(() => {
  if (!usersTyping.value.length) return null
  return usersTyping.value.length > 1
    ? `${usersTyping.value.map((u) => u.userName).join(', ')} are typing${
        ellipsis.value
      }`
    : `${usersTyping.value[0].userName} is typing${ellipsis.value}`
})

const isViewed = computed(() => !!props.modelValue.viewedAt)

const initialDragPosition = computed(() => {
  return {
    x: props.modelValue.style.x as number,
    y: props.modelValue.style.y as number
  }
})

const mp = useMixpanel()

const isDragged = ref(false)
const { x, y, isDragging, position } = useDraggable(threadContainer, {
  stopPropagation: true,
  handle,
  initialValue: initialDragPosition,
  onStart(_pos, event) {
    // Only allow dragging from header, but not from interactive elements
    const target = event.target as HTMLElement

    // Check if target is the handle or contained within it
    const isWithinHandle = target === handle.value || handle.value?.contains(target)
    if (!isWithinHandle) return false

    // Prevent dragging when clicking on buttons or other interactive elements
    const isInteractiveElement =
      target.closest('button') ||
      target.closest('a') ||
      target.closest('[role="button"]')
    if (isInteractiveElement) return false

    // Reset pos, if starting dragging from scratch
    if (!isDragged.value) position.value = { x: 0, y: 0 }

    isDragged.value = true
    mp.track('Comment Action', { type: 'action', name: 'drag' })
  }
})

const threadStyle = computed(() => {
  if (!threadActivator.value) return props.modelValue.style

  const activatorRect = threadActivator.value?.getBoundingClientRect()
  const areDraggableCoordsInitialized = x.value && y.value
  const xOffset =
    isDragged.value && areDraggableCoordsInitialized
      ? x.value
      : (props.modelValue.style.x as number) + activatorRect.width + 20
  const threadHeight = threadContainer.value?.getBoundingClientRect().height || 0
  const threadWidth = threadContainer.value?.getBoundingClientRect().width || 0
  const yOffset =
    isDragged.value && areDraggableCoordsInitialized
      ? y.value
      : (props.modelValue.style.y as number) - threadHeight / 2

  // Constrain to viewport boundaries with 10px padding
  const padding = isEmbedEnabled.value ? 5 : 10
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight

  // Use 58px top padding when not in embed mode (to account for the top bar)
  const topPadding = isEmbedEnabled.value ? padding : 58

  // Use 62px bottom padding when in embed mode (to account for the bottom controls)
  const bottomPadding = isEmbedEnabled.value ? 62 : padding

  // Ensure the element stays within the viewport. The upper bound can fall
  // below the lower one whenever the panel is taller/wider than the
  // available space (e.g. this panel grew a lot with the BCF fields/
  // viewpoint gallery) -- clamping the upper bound to never go below the
  // lower one keeps the panel's top-left corner (its header/controls) always
  // on-screen, letting it overflow off the bottom/right in that case
  // instead of being pushed off-screen to the top/left.
  const constrainedX = Math.min(
    Math.max(padding, xOffset),
    Math.max(padding, viewportWidth - threadWidth - padding)
  )
  const constrainedY = Math.min(
    Math.max(topPadding, yOffset),
    Math.max(topPadding, viewportHeight - threadHeight - bottomPadding)
  )

  const transition = isDragged.value ? 'none' : props.modelValue.style.transition
  return {
    ...props.modelValue.style,
    opacity: 1,
    transition,
    transform: `translate(${constrainedX}px,${constrainedY}px)`
  }
})

const threadAuthors = computed(() => {
  const authors = [props.modelValue.author]
  for (const author of props.modelValue.commentAuthors.items) {
    if (!authors.find((u) => u.id === author.id)) authors.push(author)
  }
  return authors
})

const isClosed = computed(() => topicStatus.value?.toLowerCase() === 'closed')

const actionsItems = computed<LayoutMenuItem[][]>(() => [
  [
    {
      title: 'Copy link',
      id: ActionTypes.CopyLink
    },
    {
      title: 'Pop in',
      id: ActionTypes.PopIn,
      disabled: !isDragged.value
    }
  ],
  [
    {
      title: isClosed.value ? 'Reopen topic' : 'Close topic',
      id: isClosed.value ? ActionTypes.ReopenTopic : ActionTypes.CloseTopic,
      disabled: !isLoggedIn.value
    },
    {
      title: 'Delete topic…',
      id: ActionTypes.DeleteTopic,
      disabled: !isLoggedIn.value
    }
  ]
])

const onDeleteConfirmed = async () => {
  if (isDeleting.value) return
  isDeleting.value = true
  try {
    if (!(await deleteTopic(props.modelValue.id))) return
    confirmDelete.value = false
    await changeExpanded(false)
    triggerNotification({ type: ToastNotificationType.Success, title: 'Topic deleted' })
  } finally {
    isDeleting.value = false
  }
}

const deleteButtons = computed((): LayoutDialogButton[] => [
  { text: 'Cancel', props: { color: 'outline' }, onClick: () => (confirmDelete.value = false) },
  {
    text: 'Delete',
    props: { color: 'danger', disabled: isDeleting.value, loading: isDeleting.value },
    onClick: onDeleteConfirmed
  }
])

const onActionChosen = (params: { item: LayoutMenuItem; event: MouseEvent }) => {
  const { item } = params

  switch (item.id) {
    case ActionTypes.CopyLink:
      showMenu.value = false
      onCopyLink()
      break
    case ActionTypes.PopIn:
      showMenu.value = false
      isDragged.value = false
      break
    case ActionTypes.CloseTopic:
      showMenu.value = false
      void onTopicStatusChanged('Closed')
      break
    case ActionTypes.ReopenTopic:
      showMenu.value = false
      void onTopicStatusChanged('Open')
      break
    case ActionTypes.DeleteTopic:
      showMenu.value = false
      confirmDelete.value = true
      break
  }
}

const changeExpanded = async (newVal: boolean) => {
  if (newVal) {
    await open(props.modelValue.id)
  } else {
    await closeAllThreads()
  }

  emit('update:expanded', newVal)
  mp.track('Comment Action', {
    type: 'action',
    name: 'toggle',
    status: newVal,
    source: 'bubble'
  })
}

const onNewReply = () => {
  justCreatedReply.value = true
  mp.track('Comment Action', { type: 'action', name: 'reply' })
}

const onCommentMounted = () => {
  if (!justCreatedReply.value) return

  const el = commentsContainer.value
  if (!el) return

  scrollToBottom(el)
  justCreatedReply.value = false
}

const onThreadClick = () => {
  changeExpanded(!isExpanded.value)
}

const onCopyLink = async () => {
  if (import.meta.server) return
  const url = getLinkToThread(projectId.value, props.modelValue)
  if (!url) return

  try {
    await copy(new URL(url, window.location.origin).toString())
  } catch (e) {
    triggerNotification({
      type: ToastNotificationType.Danger,
      title: 'Thread link copy failed',
      description: ensureError(e).message
    })
    throw e
  }

  mp.track('Comment Action', { type: 'action', name: 'share' })

  triggerNotification({
    type: ToastNotificationType.Info,
    title: 'Link copied'
  })
}

onKeyDown('Escape', () => {
  if (isExpanded.value) {
    changeExpanded(false)
  }
})

watch(
  () => [isExpanded.value, isViewed.value] as const,
  (newVals, oldVals) => {
    const [newIsExpanded, newIsViewed] = newVals
    const [oldIsExpanded] = oldVals || [false]

    if (newIsExpanded && newIsExpanded !== oldIsExpanded && !newIsViewed) {
      markThreadViewed(projectId.value, props.modelValue.id)
    }

    if (!newIsExpanded) {
      isDragged.value = false
    }
  },
  { immediate: true } // for triggering also when a comment is opened because of a thread link
)

watch(
  () => usersTyping.value.length > 1,
  (areUsersTyping) => {
    if (areUsersTyping) {
      controls.resume()
    } else {
      controls.pause()
    }
  }
)

watch(isDragging, (newVal, oldVal) => {
  if (!!newVal === !!oldVal) return

  // Disable text selection while dragging around
  disableTextSelection.value = newVal
})

onMounted(() => {
  if (isExpanded.value) {
    // update won't emit if thread was mounted already expanded, so we emit this to close any open thread editors
    emit('update:expanded', true)
  }
})

const showBanner = computed(
  () =>
    threadResourceStatus.value.isDifferentVersion ||
    threadResourceStatus.value.isFederatedModel ||
    hasClickedFullContext.value
)

const bannerText = computed(() => {
  if (hasClickedFullContext.value) return 'Viewing full context'
  if (
    threadResourceStatus.value.isDifferentVersion &&
    threadResourceStatus.value.isFederatedModel
  )
    return 'References multiple models with different versions'
  if (threadResourceStatus.value.isDifferentVersion)
    return 'Conversation started in a different version'
  if (threadResourceStatus.value.isFederatedModel)
    return 'References models not currently loaded'
  return ''
})

const bannerButton = computed(() => {
  if (hasClickedFullContext.value) {
    return {
      text: 'Back',
      icon: MoveLeft,
      action: goBack
    }
  }
  return {
    text: 'Full context',
    icon: MoveRight,
    action: handleContextClick
  }
})
</script>
<style scoped>
@media (max-width: 640px) {
  .thread-container {
    transform: none !important;
  }
}
</style>
