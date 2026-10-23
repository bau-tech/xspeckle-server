<template>
  <div>
    <div v-if="loading" class="py-8 flex justify-center">
      <CommonLoadingIcon />
    </div>
    <div
      v-else-if="!shown.length"
      class="mt-6 rounded-lg border border-dashed border-outline-2 p-6 text-center"
    >
      <p class="text-body-sm text-foreground">No BCF server connected yet.</p>
      <p class="text-body-xs text-foreground-2 mt-1">
        {{
          modelId
            ? 'Connect this model to a project on a BCF server to sync its topics.'
            : 'Connect a model to a project on a BCF server to start syncing its topics.'
        }}
      </p>
    </div>
    <ul v-else class="mt-6 flex flex-col gap-3">
      <li
        v-for="c in shown"
        :key="c.id"
        class="rounded-lg border border-outline-2 bg-foundation p-4 flex flex-col gap-3"
      >
        <div class="flex flex-wrap items-start justify-between gap-2">
          <div class="flex flex-col gap-0.5 min-w-0">
            <div class="flex items-center gap-2">
              <span class="text-heading-sm truncate">{{ c.name }}</span>
              <span
                class="text-body-3xs font-medium rounded-full px-2 py-0.5"
                :class="statusClass(c)"
              >
                {{ statusLabel(c) }}
              </span>
            </div>
            <div class="text-body-xs text-foreground-2 break-all">
              <template v-if="!modelId">
                Model
                <span class="text-foreground">{{ modelName(c.modelId) }}</span>
              </template>
              <template v-if="c.remoteProjectName">
                ⇄ BCF project
                <span class="text-foreground">{{ c.remoteProjectName }}</span>
              </template>
              · {{ bcfDirectionLabels[c.direction] }}
            </div>
            <div class="text-body-3xs text-foreground-3 break-all">{{ c.serverUrl }}</div>
          </div>
          <div class="flex flex-wrap gap-2">
            <FormButton
              v-if="c.status === 'authorized' && !c.remoteProjectId"
              size="sm"
              :disabled="busy === c.id"
              @click="openProjectDialog(c)"
            >
              Choose BCF project
            </FormButton>
            <template v-if="c.remoteProjectId">
              <FormButton
                size="sm"
                color="outline"
                :disabled="busy === c.id"
                @click="runSync(c, true)"
              >
                Preview
              </FormButton>
              <FormButton
                v-if="c.status === 'active'"
                size="sm"
                color="outline"
                :disabled="busy === c.id"
                @click="runSync(c, false)"
              >
                Sync now
              </FormButton>
              <FormButton
                v-if="c.status === 'authorized' || c.status === 'disabled'"
                size="sm"
                :disabled="busy === c.id"
                @click="activate(c)"
              >
                Start syncing
              </FormButton>
              <FormButton
                v-if="c.status === 'active'"
                size="sm"
                color="subtle"
                :disabled="busy === c.id"
                @click="disable(c)"
              >
                Pause
              </FormButton>
            </template>
            <FormButton
              size="sm"
              color="subtle"
              :icon-left="TrashIcon"
              hide-text
              :disabled="busy === c.id"
              @click="removeTarget = c"
            >
              Remove
            </FormButton>
          </div>
        </div>

        <div
          v-if="c.status === 'pending' || c.status === 'error'"
          class="text-body-xs text-foreground-2 flex flex-wrap items-center gap-2"
        >
          {{
            c.status === 'pending'
              ? 'Sign-in at the BCF server was not finished.'
              : 'The BCF server no longer accepts the sign-in.'
          }}
          <FormButton
            size="sm"
            color="outline"
            :disabled="busy === c.id"
            @click="reconnect(c)"
          >
            Sign in again
          </FormButton>
        </div>
        <CommonAlert v-if="c.lastError" color="danger" size="xs" hide-icon>
          <template #description>{{ c.lastError }}</template>
        </CommonAlert>
        <div v-if="c.lastSyncAt" class="text-body-3xs text-foreground-2">
          Last synced {{ formatDate(c.lastSyncAt) }}
          <template v-if="c.lastSyncResult">
            · {{ summaryText(c.lastSyncResult.counts) }}
            <template v-if="c.lastSyncResult.conflicts">
              · {{ c.lastSyncResult.conflicts }} conflict(s) resolved by date
            </template>
            <template v-if="c.lastSyncResult.skipped">
              · {{ c.lastSyncResult.skipped }} topic(s) skipped
            </template>
            <template v-if="c.lastSyncResult.warnings?.length">
              · {{ c.lastSyncResult.warnings.length }} value(s) adjusted for the BCF
              server, e.g. {{ c.lastSyncResult.warnings[0] }}
            </template>
          </template>
        </div>
      </li>
    </ul>

    <ProjectPageSettingsBcfConnectDialog
      v-model:open="connectOpen"
      :project-id="projectId"
      :models="models"
      :model-id="modelId"
      :servers="servers"
      :callback-url="callbackUrl"
      :return-to="returnTo"
    />
    <ProjectPageSettingsBcfProjectDialog
      v-model:open="projectDialogOpen"
      :connection="projectDialogConnection"
      :project-id="projectId"
      @chosen="onProjectChosen"
    />
    <ProjectPageSettingsBcfReportDialog
      v-model:open="reportOpen"
      :report="report"
      :connection="reportConnection"
      :busy="!!busy"
      @apply="applyFromReport"
    />
    <LayoutDialog
      :open="!!removeTarget"
      max-width="sm"
      :buttons="removeButtons"
      @update:open="(v) => !v && (removeTarget = null)"
    >
      <template #header>Remove connection</template>
      <p class="text-body-xs text-foreground">
        Stop syncing
        <span class="font-medium">{{ removeTarget && modelName(removeTarget.modelId) }}</span>
        with {{ removeTarget?.name }}? Topics already synced stay on both sides.
      </p>
    </LayoutDialog>
  </div>
</template>
<script setup lang="ts">
import { TrashIcon } from '@heroicons/vue/24/outline'
import type { LayoutDialogButton } from '@speckle/ui-components'
import { ToastNotificationType, useGlobalToast } from '~~/lib/common/composables/toast'
import {
  bcfDirectionLabels,
  bcfOperationLabel,
  useBcfServerConnections,
  type BcfConnection,
  type BcfServerChoice,
  type BcfSyncReport
} from '~~/lib/projects/composables/bcfServers'

const props = defineProps<{
  projectId: string
  /** Only this model's connections; connecting preselects it. */
  modelId?: string
}>()
const emit = defineEmits<{
  (e: 'access', value: { canManage: boolean; message: string }): void
}>()

const route = useRoute()
const router = useRouter()
const { triggerNotification } = useGlobalToast()
const api = useBcfServerConnections(() => props.projectId)

const loading = ref(true)
const canManage = ref(false)
const accessMessage = ref('Only project owners can connect BCF servers')
const connections = ref<BcfConnection[]>([])
const models = ref<Array<{ id: string; name: string }>>([])
const servers = ref<BcfServerChoice[]>([])
const callbackUrl = ref('')
const busy = ref<string | null>(null)

const connectOpen = ref(false)
const projectDialogOpen = ref(false)
const projectDialogConnection = ref<BcfConnection | null>(null)
const reportOpen = ref(false)
const report = ref<BcfSyncReport | null>(null)
const reportConnection = ref<BcfConnection | null>(null)
const removeTarget = ref<BcfConnection | null>(null)

const shown = computed(() =>
  props.modelId
    ? connections.value.filter((c) => c.modelId === props.modelId)
    : connections.value
)

const RETURN_PARAMS = ['bcfSync', 'connection', 'reason']
/** This page without the sign-in result parameters: where to come back to. */
const returnTo = computed(() => {
  const query = Object.fromEntries(
    Object.entries(route.query).filter(([k]) => !RETURN_PARAMS.includes(k))
  )
  return router.resolve({ path: route.path, query, hash: route.hash }).fullPath
})

const toastError = (title: string, e: unknown) =>
  triggerNotification({
    type: ToastNotificationType.Danger,
    title,
    description: e instanceof Error ? e.message : String(e)
  })

const refresh = async () => {
  try {
    const [list, modelList, serverList] = await Promise.all([
      api.listConnections(),
      api.listModels(),
      api.listServers()
    ])
    connections.value = list
    models.value = modelList
    servers.value = serverList.servers
    callbackUrl.value = serverList.callbackUrl
    canManage.value = true
  } catch (e) {
    canManage.value = false
    accessMessage.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
    emit('access', { canManage: canManage.value, message: accessMessage.value })
  }
}

const modelName = (id: string) => models.value.find((m) => m.id === id)?.name || id

const statusLabel = (c: BcfConnection) =>
  ({
    pending: 'Signing in',
    authorized: c.remoteProjectId ? 'Ready' : 'Choose project',
    active: 'Syncing',
    error: 'Needs attention',
    disabled: 'Paused'
  }[c.status])

const statusClass = (c: BcfConnection) =>
  ({
    pending: 'bg-foundation-2 text-foreground-2',
    authorized: 'bg-info-lighter text-info-darker',
    active: 'bg-success-lighter text-success-darker',
    error: 'bg-danger-lighter text-danger-darker',
    disabled: 'bg-foundation-2 text-foreground-2'
  }[c.status])

const formatDate = (iso: string) => new Date(iso).toLocaleString()

const summaryText = (counts: Record<string, number>) => {
  const parts = Object.entries(counts).map(([k, n]) => `${n} ${bcfOperationLabel(k).toLowerCase()}`)
  return parts.length ? parts.join(', ') : 'no changes'
}

const openProjectDialog = (c: BcfConnection) => {
  projectDialogConnection.value = c
  projectDialogOpen.value = true
}

const onProjectChosen = async (c: BcfConnection) => {
  if (c.id !== projectDialogConnection.value?.id)
    triggerNotification({
      type: ToastNotificationType.Info,
      title: 'Already connected',
      description: `This model already syncs with ${c.remoteProjectName || 'that BCF project'}; that connection now uses your new sign-in.`
    })
  await refresh()
  // Show what the first sync would do before anything is written.
  await runSync(c, true)
}

const runSync = async (c: BcfConnection, dryRun: boolean, allowMassDelete = false) => {
  busy.value = c.id
  try {
    report.value = await api.sync(c.id, { dryRun, allowMassDelete })
    reportConnection.value = c
    reportOpen.value = true
    if (!dryRun) await refresh()
  } catch (e) {
    toastError(dryRun ? 'Preview failed' : 'Sync failed', e)
    await refresh()
  } finally {
    busy.value = null
  }
}

const applyFromReport = async (opts: { activate: boolean; allowMassDelete: boolean }) => {
  const c = reportConnection.value
  if (!c) return
  if (opts.activate) {
    await activate(c, { silent: true })
  }
  await runSync(c, false, opts.allowMassDelete)
}

const activate = async (c: BcfConnection, opts?: { silent?: boolean }) => {
  busy.value = c.id
  try {
    await api.activate(c.id)
    if (!opts?.silent)
      triggerNotification({
        type: ToastNotificationType.Success,
        title: 'Syncing started',
        description: 'Changes are synced every 5 minutes.'
      })
    await refresh()
  } catch (e) {
    toastError('Could not start syncing', e)
  } finally {
    busy.value = null
  }
}

const disable = async (c: BcfConnection) => {
  busy.value = c.id
  try {
    await api.disable(c.id)
    await refresh()
  } catch (e) {
    toastError('Could not pause syncing', e)
  } finally {
    busy.value = null
  }
}

const reconnect = async (c: BcfConnection) => {
  busy.value = c.id
  try {
    const { authorizeUrl } = await api.reauthorize(c.id, returnTo.value)
    window.location.href = authorizeUrl
  } catch (e) {
    toastError('Could not reconnect', e)
    busy.value = null
  }
}

const removeButtons = computed((): LayoutDialogButton[] => [
  { text: 'Cancel', props: { color: 'outline' }, onClick: () => (removeTarget.value = null) },
  {
    text: 'Remove',
    props: { color: 'danger' },
    onClick: async () => {
      const c = removeTarget.value
      removeTarget.value = null
      if (!c) return
      try {
        await api.remove(c.id)
        await refresh()
      } catch (e) {
        toastError('Could not remove the connection', e)
      }
    }
  }
])

// Back from signing in at the BCF server (see the server's OAuth callback).
const handleReturn = async () => {
  const state = route.query.bcfSync
  if (!state) return
  const connectionId = route.query.connection as string | undefined
  const reason = route.query.reason as string | undefined
  await router.replace(returnTo.value)
  if (state === 'denied') {
    triggerNotification({
      type: ToastNotificationType.Warning,
      title: 'Not connected',
      description: reason ? `The BCF server answered: ${reason}` : 'Sign-in was cancelled.'
    })
    return
  }
  const c = connections.value.find((x) => x.id === connectionId)
  if (c && !c.remoteProjectId) openProjectDialog(c)
}

onMounted(async () => {
  await refresh()
  await handleReturn()
})

defineExpose({
  openConnect: () => {
    connectOpen.value = true
  }
})
</script>
