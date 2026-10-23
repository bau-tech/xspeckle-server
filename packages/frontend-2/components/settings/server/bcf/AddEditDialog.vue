<template>
  <LayoutDialog
    v-model:open="isOpen"
    max-width="sm"
    :buttons="dialogButtons"
    prevent-close-on-click-outside
  >
    <template #header>{{ server ? 'Edit BCF server' : 'Add BCF server' }}</template>
    <form class="flex flex-col gap-4" @submit="onSubmit">
      <FormTextInput
        v-model="name"
        name="bcfServerName"
        label="Name"
        help="As shown to project owners when connecting."
        show-label
        color="foundation"
        :rules="[isRequired]"
      />
      <FormTextInput
        v-model="url"
        name="bcfServerUrl"
        label="Address"
        placeholder="https://bcf.example.com"
        help="A server with the BCF API 3.0 and OAuth2 sign-in. It is checked when saving."
        show-label
        color="foundation"
        :rules="[isRequired, isUrl]"
      />
      <div class="flex flex-col gap-3 text-body-xs">
        <p class="text-foreground-2">
          OAuth client: leave empty for servers that register clients automatically.
          Otherwise register an OAuth2 client (authorization code flow) at the BCF server
          with this callback URL and enter its id and secret.
        </p>
        <FormClipboardInput :value="callbackUrl" />
        <FormTextInput
          v-model="clientId"
          name="bcfServerClientId"
          label="Client ID"
          show-label
          show-optional
          color="foundation"
        />
        <FormTextInput
          v-model="clientSecret"
          name="bcfServerClientSecret"
          label="Client secret"
          type="password"
          :placeholder="server?.hasClientSecret ? 'Unchanged' : undefined"
          :help="server?.hasClientSecret ? 'Leave empty to keep the stored secret.' : undefined"
          show-label
          show-optional
          color="foundation"
        />
      </div>
    </form>
  </LayoutDialog>
</template>
<script setup lang="ts">
import { useForm } from 'vee-validate'
import {
  LayoutDialog,
  FormClipboardInput,
  type LayoutDialogButton
} from '@speckle/ui-components'
import { isRequired, isUrl, fullyResetForm } from '~~/lib/common/helpers/validation'
import { ToastNotificationType, useGlobalToast } from '~~/lib/common/composables/toast'
import { useBcfServerAdmin, type BcfServer } from '~~/lib/projects/composables/bcfServers'

const props = defineProps<{
  server: BcfServer | null
  callbackUrl: string
}>()
const emit = defineEmits<{ (e: 'saved'): void }>()

const isOpen = defineModel<boolean>('open', { required: true })

const api = useBcfServerAdmin()
const { triggerNotification } = useGlobalToast()
const { handleSubmit, resetForm } = useForm()

const name = ref('')
const url = ref('')
const clientId = ref('')
const clientSecret = ref('')
const saving = ref(false)

const onSubmit = handleSubmit(async () => {
  if (saving.value) return
  saving.value = true
  try {
    const input = {
      name: name.value.trim(),
      url: url.value.trim(),
      clientId: clientId.value.trim()
    }
    if (props.server) {
      await api.update(props.server.id, {
        ...input,
        // empty keeps the stored secret, unless the client id was removed
        ...(clientSecret.value ? { clientSecret: clientSecret.value } : {})
      })
    } else {
      await api.create({
        ...input,
        ...(clientSecret.value ? { clientSecret: clientSecret.value } : {})
      })
    }
    isOpen.value = false
    emit('saved')
    triggerNotification({
      type: ToastNotificationType.Success,
      title: props.server ? 'BCF server saved' : 'BCF server added'
    })
  } catch (e) {
    triggerNotification({
      type: ToastNotificationType.Danger,
      title: 'Could not save the BCF server',
      description: e instanceof Error ? e.message : String(e)
    })
  } finally {
    saving.value = false
  }
})

watch(isOpen, (open, wasOpen) => {
  if (!open || wasOpen) return
  fullyResetForm(resetForm)
  name.value = props.server?.name || ''
  url.value = props.server?.url || ''
  clientId.value = props.server?.clientId || ''
  clientSecret.value = ''
  saving.value = false
})

const dialogButtons = computed((): LayoutDialogButton[] => [
  { text: 'Cancel', props: { color: 'outline' }, onClick: () => (isOpen.value = false) },
  {
    text: props.server ? 'Save' : 'Add',
    props: { disabled: saving.value, loading: saving.value },
    onClick: onSubmit
  }
])
</script>
