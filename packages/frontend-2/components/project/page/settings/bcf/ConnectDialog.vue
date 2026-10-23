<template>
  <LayoutDialog
    v-model:open="isOpen"
    max-width="sm"
    :buttons="dialogButtons"
    prevent-close-on-click-outside
  >
    <template #header>Connect a BCF server</template>
    <form class="flex flex-col gap-4" @submit="onSubmit">
      <FormSelectBase
        v-model="model"
        name="bcfModel"
        label="Model"
        placeholder="Choose a model"
        help="Its topics are synced. Topics created on the BCF server are added to it."
        show-label
        :items="models"
        by="id"
        mount-menu-on-body
        :rules="[isModelSelected]"
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

      <FormSelectBase
        v-if="serverItems.length > 1"
        v-model="server"
        name="bcfServer"
        label="BCF server"
        show-label
        :items="serverItems"
        by="id"
        mount-menu-on-body
      >
        <template #something-selected="{ value }">
          <span class="label label--light truncate">
            {{ Array.isArray(value) ? value[0]?.name : value.name }}
          </span>
        </template>
        <template #option="{ item }">
          <div class="flex flex-col min-w-0">
            <span class="label label--light truncate">{{ item.name }}</span>
            <span v-if="item.url" class="text-body-3xs text-foreground-2 truncate">
              {{ item.url }}
            </span>
          </div>
        </template>
      </FormSelectBase>
      <FormTextInput
        v-if="isOther"
        v-model="serverUrl"
        name="bcfServerUrl"
        :label="serverItems.length > 1 ? 'Server address' : 'BCF server'"
        placeholder="https://bcf.example.com"
        help="Any server with the BCF API 3.0 and OAuth2 sign-in."
        show-label
        color="foundation"
        :rules="[isRequired, isUrl]"
      />

      <FormSelectBase
        v-model="direction"
        name="bcfDirection"
        label="Direction"
        show-label
        :items="directionItems"
        by="id"
        mount-menu-on-body
      >
        <template #something-selected="{ value }">
          <span class="label label--light">
            {{ Array.isArray(value) ? value[0]?.text : value.text }}
          </span>
        </template>
        <template #option="{ item }">
          <div class="flex flex-col">
            <span class="label label--light">{{ item.text }}</span>
            <span class="text-body-3xs text-foreground-2">{{ item.help }}</span>
          </div>
        </template>
      </FormSelectBase>
      <FormTextInput
        v-model="name"
        name="bcfName"
        label="Name"
        help="Optional, to tell connections apart. Defaults to the server's name."
        show-label
        show-optional
        color="foundation"
      />

      <LayoutDisclosure v-if="!server?.hasClient" title="Registered OAuth client">
        <div class="flex flex-col gap-3 text-body-xs">
          <p class="text-foreground-2">
            Only needed for servers that do not register clients automatically. Register
            an OAuth2 client (authorization code flow) at the BCF server with this
            callback URL, then enter its id and secret.
          </p>
          <FormClipboardInput :value="callbackUrl" />
          <FormTextInput
            v-model="clientId"
            name="bcfClientId"
            label="Client ID"
            show-label
            show-optional
            color="foundation"
          />
          <FormTextInput
            v-model="clientSecret"
            name="bcfClientSecret"
            label="Client secret"
            type="password"
            show-label
            show-optional
            color="foundation"
          />
        </div>
      </LayoutDisclosure>

      <p class="text-body-xs text-foreground-2">
        You will be sent to the BCF server to sign in. Nothing is synced until you have
        chosen the BCF project and looked at a preview.
      </p>
    </form>
  </LayoutDialog>
</template>
<script setup lang="ts">
import { useForm } from 'vee-validate'
import {
  LayoutDialog,
  LayoutDisclosure,
  FormSelectBase,
  FormClipboardInput,
  type LayoutDialogButton
} from '@speckle/ui-components'
import { isRequired, isUrl, fullyResetForm } from '~~/lib/common/helpers/validation'
import { ToastNotificationType, useGlobalToast } from '~~/lib/common/composables/toast'
import {
  bcfDirectionLabels,
  useBcfServerConnections,
  type BcfServerChoice,
  type BcfSyncDirection
} from '~~/lib/projects/composables/bcfServers'

const props = defineProps<{
  projectId: string
  models: Array<{ id: string; name: string }>
  servers: BcfServerChoice[]
  callbackUrl: string
}>()

const isOpen = defineModel<boolean>('open', { required: true })

const api = useBcfServerConnections(() => props.projectId)
const { triggerNotification } = useGlobalToast()
const { handleSubmit, resetForm } = useForm()

const directionItems: Array<{ id: BcfSyncDirection; text: string; help: string }> = [
  {
    id: 'two-way',
    text: bcfDirectionLabels['two-way'],
    help: 'Changes on either side are carried over.'
  },
  {
    id: 'pull',
    text: bcfDirectionLabels.pull,
    help: 'Nothing here is ever written to the BCF server.'
  },
  {
    id: 'push',
    text: bcfDirectionLabels.push,
    help: 'Nothing on the BCF server is ever written here.'
  }
]

type ServerItem = { id: string; name: string; url: string; hasClient: boolean }
const OTHER = '__other__'

/** The admin's servers, then ones used in this project, then any other. */
const serverItems = computed((): ServerItem[] => [
  ...props.servers.map((s) => ({ id: s.url, name: s.name, url: s.url, hasClient: s.hasClient })),
  { id: OTHER, name: 'Other server…', url: '', hasClient: false }
])

const model = ref<{ id: string; name: string } | undefined>()
const server = ref<ServerItem | undefined>()
const serverUrl = ref('')
const direction = ref(directionItems[0])
const name = ref('')
const clientId = ref('')
const clientSecret = ref('')
const submitting = ref(false)

const isOther = computed(() => !server.value || server.value.id === OTHER)

const isModelSelected = (v: unknown) => (v ? true : 'Choose a model')

const onSubmit = handleSubmit(async () => {
  if (!model.value || submitting.value) return
  const url = isOther.value ? serverUrl.value.trim() : server.value!.url
  submitting.value = true
  try {
    const { authorizeUrl } = await api.startConnection({
      modelId: model.value.id,
      serverUrl: url,
      name: name.value.trim() || (isOther.value ? undefined : server.value!.name),
      direction: direction.value.id,
      clientId: clientId.value.trim() || undefined,
      clientSecret: clientSecret.value || undefined
    })
    window.location.href = authorizeUrl
  } catch (e) {
    submitting.value = false
    triggerNotification({
      type: ToastNotificationType.Danger,
      title: 'Could not connect',
      description: e instanceof Error ? e.message : String(e)
    })
  }
})

watch(isOpen, (open, wasOpen) => {
  if (!open || wasOpen) return
  fullyResetForm(resetForm)
  model.value = props.models.length === 1 ? props.models[0] : undefined
  server.value = serverItems.value[0]
  serverUrl.value = ''
  direction.value = directionItems[0]
  name.value = ''
  clientId.value = ''
  clientSecret.value = ''
  submitting.value = false
})

const dialogButtons = computed((): LayoutDialogButton[] => [
  { text: 'Cancel', props: { color: 'outline' }, onClick: () => (isOpen.value = false) },
  {
    text: 'Sign in and connect',
    props: { disabled: submitting.value, loading: submitting.value },
    onClick: onSubmit
  }
])
</script>
