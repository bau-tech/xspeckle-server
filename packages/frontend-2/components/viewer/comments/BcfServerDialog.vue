<template>
  <LayoutDialog v-model:open="isOpen" max-width="md" :buttons="buttons">
    <template #header>BCF server</template>
    <div class="flex flex-col gap-3 text-body-xs">
      <p class="text-foreground">
        Keep this model's BCF topics in sync with a project on a BCF server. Topics,
        comments and viewpoints are synced; changes on either side are carried over.
      </p>
      <FormSelectBase
        v-if="models.length > 1"
        v-model="model"
        name="bcfViewerModel"
        label="Model"
        show-label
        :items="models"
        by="id"
        mount-menu-on-body
      >
        <template #something-selected="{ value }">
          <span class="label label--light truncate">
            {{ Array.isArray(value) ? value[0]?.name : value.name }}
          </span>
        </template>
        <template #option="{ item }">
          <span class="label label--light truncate">{{ item.name }}</span>
        </template>
      </FormSelectBase>
      <ProjectPageSettingsBcfConnections
        v-if="model"
        ref="connections"
        :key="model.id"
        :project-id="currentProjectId"
        :model-id="model.id"
        @access="(v) => (access = v)"
      />
      <p v-if="!access.canManage && access.message" class="text-foreground-2">
        {{ access.message }}
      </p>
    </div>
  </LayoutDialog>
</template>
<script setup lang="ts">
import { LayoutDialog, FormSelectBase, type LayoutDialogButton } from '@speckle/ui-components'
import {
  useInjectedViewerLoadedResources,
  useInjectedViewerState
} from '~~/lib/viewer/composables/setup'

const isOpen = defineModel<boolean>('open', { required: true })

const { projectId } = useInjectedViewerState()
const currentProjectId = computed(() => projectId.value)
const { modelsAndVersionIds } = useInjectedViewerLoadedResources()

const models = computed(() =>
  modelsAndVersionIds.value.map(({ model }) => ({ id: model.id, name: model.name }))
)
const model = ref<{ id: string; name: string } | undefined>()
const connections = ref<{ openConnect: () => void } | null>(null)
const access = ref({ canManage: false, message: '' })

watch(
  [isOpen, models],
  ([open]) => {
    if (open && (!model.value || !models.value.some((m) => m.id === model.value?.id)))
      model.value = models.value[0]
  },
  { immediate: true }
)

const buttons = computed((): LayoutDialogButton[] => [
  { text: 'Close', props: { color: 'outline' }, onClick: () => (isOpen.value = false) },
  {
    text: 'Connect',
    props: { disabled: !access.value.canManage },
    onClick: () => connections.value?.openConnect()
  }
])
</script>
