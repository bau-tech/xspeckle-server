<template>
  <ViewerLayoutSidePanel>
    <template #title>
      <span>BCF</span>
    </template>
    <template #actions>
      <div class="flex items-center leading-none">
        <LayoutMenu
          v-model:open="showVisibilityOptions"
          :menu-id="menuId"
          :items="actionsItems"
          :menu-position="HorizontalDirection.Right"
          mount-menu-on-body
          :custom-menu-items-classes="['!w-[270px]']"
          show-ticks
          @click.stop.prevent
          @chosen="onActionChosen"
        >
          <FormButton
            hide-text
            color="subtle"
            :icon-left="settingsIcon"
            size="sm"
            :class="
              showVisibilityOptions
                ? '!text-primary-focus !dark:text-foreground-on-primary !bg-info-lighter'
                : ''
            "
            @click="showVisibilityOptions = !showVisibilityOptions"
          />
        </LayoutMenu>
        <input
          ref="bcfFileInput"
          type="file"
          accept=".bcf,.bcfzip"
          class="hidden"
          @change="onBcfFileChosen"
        />
        <ViewerCommentsBcfServerDialog v-if="isBcfSyncEnabled" v-model:open="bcfServerOpen" />
      </div>
    </template>
    <div class="flex flex-col h-full">
      <div class="flex flex-col flex-1 gap-y-2 p-1">
        <ViewerCommentsListItem
          v-for="thread in commentThreads"
          :key="thread.id"
          :thread="thread"
        />
        <ProjectPageLatestItemsCommentsEmptyState v-if="commentThreads.length === 0" />
      </div>
    </div>
  </ViewerLayoutSidePanel>
</template>
<script setup lang="ts">
import { graphql } from '~~/lib/common/generated/gql'
import type { ConcreteComponent } from 'vue'
import {
  useInjectedViewerInterfaceState,
  useInjectedViewerLoadedResources,
  useInjectedViewerRequestedResources
} from '~~/lib/viewer/composables/setup'
import { useMixpanel } from '~~/lib/core/composables/mp'
import type { LayoutMenuItem } from '~~/lib/layout/helpers/components'
import { HorizontalDirection } from '~~/lib/common/composables/window'
import { useViewerBcfTransfer } from '~~/lib/viewer/composables/bcfTransfer'

enum ActionTypes {
  HideBubbles = 'hide-bubbles',
  LoadedVersionsOnly = 'loaded-versions-only',
  ImportBcf = 'import-bcf',
  ExportBcf21 = 'export-bcf-2.1',
  ExportBcf30 = 'export-bcf-3.0',
  BcfServer = 'bcf-server'
}

graphql(`
  fragment ViewerCommentsListItem on Topic {
    id
    rawText
    author {
      ...LimitedUserAvatar
    }
    createdAt
    viewedAt
    comments {
      totalCount
      cursor
      items {
        ...ViewerCommentsReplyItem
      }
    }
    commentAuthors(limit: 4) {
      totalCount
      items {
        ...FormUsersSelectItem
      }
    }
    resources {
      resourceId
      resourceType
    }
  }
`)

const { commentThreads } = useInjectedViewerLoadedResources()
const { threadFilters } = useInjectedViewerRequestedResources()
const {
  threads: { hideBubbles }
} = useInjectedViewerInterfaceState()
const menuId = useId()
const { busy: bcfBusy, exportBcf, importBcf } = useViewerBcfTransfer()
const bcfFileInput = ref<HTMLInputElement>()
const isBcfSyncEnabled = useIsBcfSyncEnabled()
const route = useRoute()
// Back from signing in at a BCF server: carry on in its dialog.
const bcfServerOpen = ref(!!route.query.bcfSync)

const showVisibilityOptions = ref(false)
const settingsIcon = resolveComponent('IconViewerSettings') as ConcreteComponent

const loadedVersionsOnly = computed({
  get: () =>
    threadFilters.value.loadedVersionsOnly || false ? 'loadedVersionsOnly' : undefined,
  set: (newVal) => (threadFilters.value.loadedVersionsOnly = !!newVal)
})

const mp = useMixpanel()
watch(loadedVersionsOnly, (newVal) =>
  mp.track('Comment Action', {
    type: 'action',
    name: 'settings-change',
    loadedVersionsOnly: newVal
  })
)

const actionsItems = computed<LayoutMenuItem[][]>(() => [
  [
    {
      title: 'Show in 3D model',
      id: ActionTypes.HideBubbles,
      active: !hideBubbles.value
    },
    {
      title: 'Exclude threads from other versions',
      id: ActionTypes.LoadedVersionsOnly,
      active: !!loadedVersionsOnly.value
    }
  ],
  [
    {
      title: 'Import BCF file (.bcf, .bcfzip)…',
      id: ActionTypes.ImportBcf,
      disabled: bcfBusy.value
    },
    {
      title: 'Export topics as BCF 2.1 (.bcfzip)',
      id: ActionTypes.ExportBcf21,
      disabled: bcfBusy.value || commentThreads.value.length === 0
    },
    {
      title: 'Export topics as BCF 3.0 (.bcf)',
      id: ActionTypes.ExportBcf30,
      disabled: bcfBusy.value || commentThreads.value.length === 0
    }
  ],
  ...(isBcfSyncEnabled.value
    ? [
        [
          {
            title: 'BCF server…',
            id: ActionTypes.BcfServer
          }
        ]
      ]
    : [])
])

const onBcfFileChosen = async (event: Event) => {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = '' // allow choosing the same file again
  if (file) await importBcf(file)
}

const onActionChosen = (params: { item: LayoutMenuItem; event: MouseEvent }) => {
  const { item } = params

  switch (item.id) {
    case ActionTypes.ImportBcf:
      bcfFileInput.value?.click()
      break
    case ActionTypes.ExportBcf21:
      void exportBcf('2.1')
      break
    case ActionTypes.ExportBcf30:
      void exportBcf('3.0')
      break
    case ActionTypes.BcfServer:
      bcfServerOpen.value = true
      break
    case ActionTypes.HideBubbles:
      hideBubbles.value = !hideBubbles.value
      break
    case ActionTypes.LoadedVersionsOnly:
      loadedVersionsOnly.value = loadedVersionsOnly.value
        ? undefined
        : 'loadedVersionsOnly'
      break
  }
}
</script>
