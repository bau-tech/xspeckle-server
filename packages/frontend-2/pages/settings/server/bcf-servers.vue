<template>
  <section>
    <div class="md:max-w-5xl md:mx-auto pb-6 md:pb-0">
      <SettingsSectionHeader
        title="BCF servers"
        text="The BCF servers offered when connecting a model under project settings. Project owners can still connect to any other BCF API 3.0 server by its address."
      />
      <div class="flex flex-col space-y-6">
        <div class="flex flex-row-reverse">
          <FormButton @click="onCreate">Add</FormButton>
        </div>
        <LayoutTable
          :items="servers"
          :columns="[
            { id: 'name', header: 'Name', classes: 'col-span-3 truncate' },
            { id: 'url', header: 'Address', classes: 'col-span-6 truncate' },
            { id: 'client', header: 'OAuth client', classes: 'col-span-3 truncate' }
          ]"
          :buttons="[
            { icon: PencilIcon, label: 'Edit', action: onEdit },
            { icon: TrashIcon, label: 'Remove', action: onRemove }
          ]"
          :empty-message="loading ? 'Loading…' : 'No BCF servers set up'"
        >
          <template #name="{ item }">{{ item.name }}</template>
          <template #url="{ item }">
            <span class="text-foreground-2">{{ item.url }}</span>
          </template>
          <template #client="{ item }">
            <span class="text-foreground-2">
              {{ item.clientId ? item.clientId : 'Registered automatically' }}
            </span>
          </template>
        </LayoutTable>
      </div>
    </div>
    <SettingsServerBcfAddEditDialog
      v-model:open="dialogOpen"
      :server="editing"
      :callback-url="callbackUrl"
      @saved="refresh"
    />
    <LayoutDialog
      :open="!!removeTarget"
      max-width="sm"
      :buttons="removeButtons"
      @update:open="(v) => !v && (removeTarget = null)"
    >
      <template #header>Remove BCF server</template>
      <p class="text-body-xs text-foreground">
        Stop offering
        <span class="font-medium">{{ removeTarget?.name }}</span>
        when connecting? Existing connections to it keep syncing.
      </p>
    </LayoutDialog>
  </section>
</template>
<script setup lang="ts">
import { PencilIcon, TrashIcon } from '@heroicons/vue/24/outline'
import { LayoutDialog, type LayoutDialogButton } from '@speckle/ui-components'
import { ToastNotificationType, useGlobalToast } from '~~/lib/common/composables/toast'
import { useBcfServerAdmin, type BcfServer } from '~~/lib/projects/composables/bcfServers'

definePageMeta({
  layout: 'settings'
})

useHead({
  title: 'Settings | Server - BCF servers'
})

const api = useBcfServerAdmin()
const { triggerNotification } = useGlobalToast()
const apiOrigin = useApiOrigin()

/** Where a BCF server sends users back after signing in (for registering a client). */
const callbackUrl = `${apiOrigin}/api/v1/bcf-sync/callback`

const loading = ref(true)
const servers = ref<BcfServer[]>([])
const dialogOpen = ref(false)
const editing = ref<BcfServer | null>(null)
const removeTarget = ref<BcfServer | null>(null)

const refresh = async () => {
  try {
    servers.value = await api.list()
  } catch (e) {
    triggerNotification({
      type: ToastNotificationType.Danger,
      title: 'Could not load the BCF servers',
      description: e instanceof Error ? e.message : String(e)
    })
  } finally {
    loading.value = false
  }
}

const onCreate = () => {
  editing.value = null
  dialogOpen.value = true
}

const onEdit = (s: BcfServer) => {
  editing.value = s
  dialogOpen.value = true
}

const onRemove = (s: BcfServer) => {
  removeTarget.value = s
}

const removeButtons = computed((): LayoutDialogButton[] => [
  { text: 'Cancel', props: { color: 'outline' }, onClick: () => (removeTarget.value = null) },
  {
    text: 'Remove',
    props: { color: 'danger' },
    onClick: async () => {
      const s = removeTarget.value
      removeTarget.value = null
      if (!s) return
      try {
        await api.remove(s.id)
        await refresh()
      } catch (e) {
        triggerNotification({
          type: ToastNotificationType.Danger,
          title: 'Could not remove the BCF server',
          description: e instanceof Error ? e.message : String(e)
        })
      }
    }
  }
])

onMounted(refresh)
</script>
