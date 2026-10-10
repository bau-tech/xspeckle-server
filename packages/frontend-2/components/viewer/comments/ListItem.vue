<!-- eslint-disable vuejs-accessibility/no-static-element-interactions -->
<template>
  <!-- eslint-disable-next-line vuejs-accessibility/click-events-have-key-events -->
  <div
    :class="`p-1.5 pt-0.5 flex flex-col rounded-md
      ${isOpenInViewer ? 'bg-highlight-2' : ''}
      ${isLimited ? 'cursor-default' : 'cursor-pointer hover:bg-highlight-3'}
    `"
    @click="isLimited ? null : open(thread.id)"
  >
    <div class="flex-1 flex flex-col gap-y-1">
      <div class="flex items-center space-x-1.5 justify-between">
        <UserAvatarGroup :users="threadAuthors" size="sm" />
      </div>
      <div class="flex items-center gap-x-1.5 text-body-3xs">
        <span class="text-foreground">
          {{ thread.author.name }}
          <span v-if="threadAuthors.length !== 1">
            & {{ thread.commentAuthors.totalCount }} others
          </span>
        </span>

        <span v-tippy="createdAt.full" class="text-foreground-3">
          {{ createdAt.relative }}
        </span>
      </div>
      <div v-if="!isLimited" class="py-1">
        <div
          v-if="thread.title"
          class="text-body-2xs font-medium text-foreground line-clamp-1"
        >
          {{ thread.title }}
        </div>
        <div
          v-if="thread.rawText?.trim()"
          class="text-body-2xs text-foreground dark:text-foreground-2 line-clamp-2"
        >
          {{ thread.rawText }}
        </div>
      </div>
      <ViewerResourcesLimitAlert v-else limit-type="comment" :project="project" />
      <div class="text-body-3xs flex items-center space-x-1.5 text-foreground-3">
        <div
          v-if="itemStatus.isDifferentVersion || itemStatus.isFederatedModel"
          class="flex items-center space-x-1"
        >
          <div
            v-if="itemStatus.isDifferentVersion"
            v-tippy="'Conversation started in a different version.'"
          >
            <ClockIcon class="size-3 text-foreground-2" />
          </div>
          <div
            v-if="itemStatus.isFederatedModel"
            v-tippy="'References models not currently loaded.'"
          >
            <IconCircleExclamation class="size-3 text-foreground-2" />
          </div>
        </div>
        <span>
          {{ thread.comments.totalCount }}
          {{ thread.comments.totalCount === 1 ? 'reply' : 'replies' }}
        </span>
      </div>
    </div>
  </div>
</template>
<script setup lang="ts">
import { ClockIcon } from '@heroicons/vue/24/solid'
import type { LoadedCommentThread } from '~~/lib/viewer/composables/setup'
import {
  useInjectedViewerInterfaceState,
  useInjectedViewerState
} from '~~/lib/viewer/composables/setup'
import { useCommentContext } from '~~/lib/viewer/composables/commentManagement'
import { useMixpanel } from '~~/lib/core/composables/mp'
import { useThreadUtilities } from '~~/lib/viewer/composables/ui'

const props = defineProps<{
  thread: LoadedCommentThread
}>()

const {
  threads: { openThread }
} = useInjectedViewerInterfaceState()
const { open: openThreadRaw } = useThreadUtilities()
const {
  resources: {
    response: { project }
  }
} = useInjectedViewerState()

// The server withholds the text (null) of a topic beyond the plan's history
// limit. An empty string is just an empty description -- optional in BCF, so
// e.g. a topic synced from the external BCF server with only a title -- not a limit.
const isLimited = computed(() => props.thread.rawText === null)

const mp = useMixpanel()
const open = (id: string) => {
  openThreadRaw(id)
  mp.track('Comment Action', {
    type: 'action',
    name: 'toggle',
    status: !isOpenInViewer.value,
    source: 'sidebar'
  })
}

const { calculateThreadResourceStatus } = useCommentContext()
const itemStatus = computed(() => calculateThreadResourceStatus(props.thread))
const { formattedRelativeDate, formattedFullDate } = useDateFormatters()

const createdAt = computed(() => {
  return {
    full: formattedFullDate(props.thread.createdAt),
    relative: formattedRelativeDate(props.thread.createdAt, { capitalize: true })
  }
})

const isOpenInViewer = computed(() => openThread.thread.value?.id === props.thread.id)

const threadAuthors = computed(() => {
  const authors = [props.thread.author]
  for (const author of props.thread.commentAuthors.items) {
    if (!authors.find((u) => u.id === author.id)) authors.push(author)
  }
  return authors
})
</script>
