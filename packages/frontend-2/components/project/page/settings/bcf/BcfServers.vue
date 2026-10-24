<template>
  <ProjectPageSettingsBlock :auth-check="authCheck" title="BCF servers">
    <template #introduction>
      <p class="text-body-xs text-foreground">
        Keep the BCF topics of a model in sync with a project on a BCF server, any
        server with the BCF API 3.0 or 2.1 and OAuth2 sign-in. Topics, comments and viewpoints
        are synced; changes made on either side are carried over.
      </p>
    </template>
    <template #top-buttons>
      <FormButton :disabled="!access.canManage" @click="connections?.openConnect()">
        Connect
      </FormButton>
    </template>
    <ProjectPageSettingsBcfConnections
      ref="connections"
      :project-id="projectId"
      @access="(v) => (access = { ...v, loaded: true })"
    />
  </ProjectPageSettingsBlock>
</template>
<script setup lang="ts">
import type { FullPermissionCheckResultFragment } from '~~/lib/common/generated/gql/graphql'

defineProps<{ projectId: string }>()

const connections = ref<{ openConnect: () => void } | null>(null)
const access = ref({ canManage: false, message: '', loaded: false })

const authCheck = computed(
  () =>
    ({
      __typename: 'PermissionCheckResult',
      authorized: access.value.canManage || !access.value.loaded,
      code: access.value.canManage ? 'OK' : 'FORBIDDEN',
      message: access.value.message || 'Only project owners can connect BCF servers',
      payload: null
    } as unknown as FullPermissionCheckResultFragment)
)
</script>
