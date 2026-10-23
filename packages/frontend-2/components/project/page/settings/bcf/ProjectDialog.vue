<template>
  <LayoutDialog v-model:open="isOpen" max-width="sm" :buttons="dialogButtons">
    <template #header>Choose the BCF project</template>
    <div class="flex flex-col gap-3">
      <p class="text-body-xs text-foreground">
        Signed in to {{ connection?.name }}. Which of its projects should the topics of
        this model be synced with?
      </p>
      <div v-if="loading" class="py-4 flex justify-center"><CommonLoadingIcon /></div>
      <CommonAlert v-else-if="error" color="danger" size="xs" hide-icon>
        <template #description>{{ error }}</template>
      </CommonAlert>
      <p v-else-if="!projects.length" class="text-body-xs text-foreground-2">
        Your account has no projects on this BCF server.
      </p>
      <FormSelectBase
        v-else
        v-model="selected"
        name="bcfRemoteProject"
        label="BCF project"
        placeholder="Choose a project"
        show-label
        :items="projects"
        by="id"
        mount-menu-on-body
        search
        :filter-predicate="matchesProject"
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
    </div>
  </LayoutDialog>
</template>
<script setup lang="ts">
import { LayoutDialog, FormSelectBase, type LayoutDialogButton } from '@speckle/ui-components'
import { ToastNotificationType, useGlobalToast } from '~~/lib/common/composables/toast'
import {
  useBcfServerConnections,
  type BcfConnection
} from '~~/lib/projects/composables/bcfServers'

const props = defineProps<{
  projectId: string
  connection: BcfConnection | null
}>()
const emit = defineEmits<{ (e: 'chosen', connection: BcfConnection): void }>()

const isOpen = defineModel<boolean>('open', { required: true })

const api = useBcfServerConnections(() => props.projectId)
const { triggerNotification } = useGlobalToast()

const loading = ref(false)
const saving = ref(false)
const error = ref<string | null>(null)
const projects = ref<Array<{ id: string; name: string }>>([])
const selected = ref<{ id: string; name: string } | undefined>()

const matchesProject = (item: { name: string }, search: string) =>
  item.name.toLowerCase().includes(search.toLowerCase())

watch(isOpen, async (open) => {
  if (!open || !props.connection) return
  loading.value = true
  error.value = null
  selected.value = undefined
  try {
    projects.value = await api.listRemoteProjects(props.connection.id)
    if (projects.value.length === 1) selected.value = projects.value[0]
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
})

const save = async () => {
  if (!props.connection || !selected.value) return
  saving.value = true
  try {
    const updated = await api.selectRemoteProject(props.connection.id, {
      remoteProjectId: selected.value.id
    })
    isOpen.value = false
    emit('chosen', updated)
  } catch (e) {
    triggerNotification({
      type: ToastNotificationType.Danger,
      title: 'Could not use that project',
      description: e instanceof Error ? e.message : String(e)
    })
  } finally {
    saving.value = false
  }
}

const dialogButtons = computed((): LayoutDialogButton[] => [
  { text: 'Later', props: { color: 'outline' }, onClick: () => (isOpen.value = false) },
  {
    text: 'Continue',
    props: { disabled: !selected.value || saving.value, loading: saving.value },
    onClick: save
  }
])
</script>
