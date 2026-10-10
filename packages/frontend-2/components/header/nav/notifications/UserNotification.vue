<template>
  <button
    type="button"
    class="w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-highlight-1"
    :class="notification.read ? 'opacity-60' : ''"
    @click="$emit('open', notification)"
  >
    <img
      v-if="isBcf"
      src="/images/bcf-icon.png"
      alt="BCF"
      class="size-5 shrink-0 mt-0.5 object-contain"
    />
    <div class="min-w-0 flex-1">
      <div class="text-body-2xs text-foreground break-words">
        {{ notification.message }}
      </div>
      <div
        v-tippy="formattedFullDate(notification.createdAt)"
        class="text-body-3xs text-foreground-2 mt-0.5"
      >
        {{ formattedRelativeDate(notification.createdAt, { prefix: true }) }}
      </div>
    </div>
    <div
      v-if="!notification.read"
      class="size-2 shrink-0 mt-1.5 rounded-full bg-primary"
    />
  </button>
</template>
<script setup lang="ts">
import { graphql } from '~~/lib/common/generated/gql'
import type { HeaderNavNotificationsUserNotification_UserNotificationFragment } from '~~/lib/common/generated/gql/graphql'

graphql(`
  fragment HeaderNavNotificationsUserNotification_UserNotification on UserNotification {
    id
    type
    read
    createdAt
    message
    projectId
    topicId
  }
`)

const props = defineProps<{
  notification: HeaderNavNotificationsUserNotification_UserNotificationFragment
}>()

defineEmits<{
  open: [notification: HeaderNavNotificationsUserNotification_UserNotificationFragment]
}>()

const { formattedRelativeDate, formattedFullDate } = useDateFormatters()

const isBcf = computed(() => props.notification.type === 'bcfTopicAssigned')
</script>
