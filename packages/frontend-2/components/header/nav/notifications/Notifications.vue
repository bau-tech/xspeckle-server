<template>
  <div>
    <Menu as="div" class="flex items-center">
      <MenuButton :id="menuButtonId" v-slot="{ open: menuOpen }" as="div">
        <div
          class="relative cursor-pointer p-1 w-8 h-8 flex items-center justify-center rounded-md"
          :class="menuOpen ? 'border border-outline-2' : ''"
        >
          <span class="sr-only">Open notifications menu</span>
          <div class="relative">
            <div
              v-if="!menuOpen && hasUnread"
              class="absolute -top-[4px] -right-[4px] size-2 bg-danger rounded-full"
            />

            <BellIcon v-if="!menuOpen" class="w-5 h-5" />
            <XMarkIcon v-else class="w-5 h-5" />
          </div>
        </div>
      </MenuButton>
      <Transition
        enter-active-class="transition ease-out duration-200"
        enter-from-class="transform opacity-0 scale-95"
        enter-to-class="transform opacity-100 scale-100"
        leave-active-class="transition ease-in duration-75"
        leave-from-class="transform opacity-100 scale-100"
        leave-to-class="transform opacity-0 scale-95"
      >
        <MenuItems
          class="absolute z-50 right-0 md:right-20 top-10 mt-1.5 w-full sm:w-72 origin-top-right bg-foundation outline outline-2 outline-primary-muted rounded-md shadow-lg overflow-hidden pb-1"
        >
          <div class="flex items-center justify-between gap-2 px-3.5 pt-2">
            <span class="text-body-xs font-medium">Notifications</span>
            <div class="flex items-center gap-2">
              <button
                v-if="unreadCount"
                type="button"
                class="text-body-3xs text-foreground-2 hover:text-foreground"
                @click="markAllRead"
              >
                Mark all read
              </button>
              <button
                v-if="hasReadNotifications"
                type="button"
                class="text-body-3xs text-foreground-2 hover:text-danger"
                @click="clearRead"
              >
                Clear read
              </button>
            </div>
          </div>
          <p
            v-if="!hasNotifications"
            class="px-3.5 pt-2 pb-2.5 text-body-xs text-foreground-2 text-center"
          >
            No notifications
          </p>
          <MenuItem v-for="projectInvite in projectsInvites" :key="projectInvite?.id">
            <HeaderNavNotificationsProjectInvite :invite="projectInvite" />
          </MenuItem>
          <MenuItem
            v-for="workspacesInvite in workspacesInvites"
            :key="workspacesInvite?.id"
          >
            <HeaderNavNotificationsWorkspaceInvite :invite="workspacesInvite" />
          </MenuItem>
          <div v-if="userNotifications.length" class="max-h-96 overflow-y-auto">
            <MenuItem v-for="notification in userNotifications" :key="notification.id">
              <HeaderNavNotificationsUserNotification
                :notification="notification"
                @open="openNotification"
              />
            </MenuItem>
          </div>
        </MenuItems>
      </Transition>
    </Menu>
  </div>
</template>
<script setup lang="ts">
import { Menu, MenuButton, MenuItem, MenuItems } from '@headlessui/vue'
import { XMarkIcon, BellIcon } from '@heroicons/vue/24/outline'
import { useMutation, useQuery } from '@vue/apollo-composable'
import type { HeaderNavNotificationsUserNotification_UserNotificationFragment } from '~~/lib/common/generated/gql/graphql'
import { threadRedirectRoute } from '~~/lib/common/helpers/route'
import {
  clearReadUserNotificationsMutation,
  markAllUserNotificationsReadMutation,
  markUserNotificationsReadMutation
} from '~~/lib/navigation/graphql/mutations'
import {
  navigationProjectInvitesQuery,
  navigationUserNotificationsQuery,
  navigationWorkspaceInvitesQuery
} from '~~/lib/navigation/graphql/queries'

const menuButtonId = useId()
const isWorkspacesEnabled = useIsWorkspacesEnabled()

const { result: projectInviteResult } = useQuery(navigationProjectInvitesQuery)
const { result: workspaceInviteResult } = useQuery(
  navigationWorkspaceInvitesQuery,
  null,
  { enabled: isWorkspacesEnabled.value }
)

const projectsInvites = computed(
  () => projectInviteResult.value?.activeUser?.projectInvites
)
const workspacesInvites = computed(() => {
  const invites = workspaceInviteResult.value?.activeUser?.workspaceInvites

  // Filter out implicit workspace invites that already show up as project invites here (same ID)
  return (
    invites?.filter((invite) => {
      return !projectsInvites.value?.some(
        (projectInvite) => projectInvite.id === invite.id
      )
    }) || []
  )
})

// Same 20s poll as the external BCF server's bell -- new ones can arrive any time
const { result: userNotificationsResult, refetch: refetchUserNotifications } = useQuery(
  navigationUserNotificationsQuery,
  null,
  () => ({
    pollInterval: import.meta.client ? 20000 : undefined
  })
)
const { mutate: markRead } = useMutation(markUserNotificationsReadMutation)
const { mutate: markAllReadMutate } = useMutation(markAllUserNotificationsReadMutation)
const { mutate: clearReadMutate } = useMutation(clearReadUserNotificationsMutation)

const userNotifications = computed(
  () => userNotificationsResult.value?.activeUser?.notifications || []
)
const unreadCount = computed(
  () => userNotificationsResult.value?.activeUser?.unreadNotificationCount || 0
)
const hasReadNotifications = computed(() => userNotifications.value.some((n) => n.read))

const openNotification = async (
  notification: HeaderNavNotificationsUserNotification_UserNotificationFragment
) => {
  if (!notification.read) await markRead({ ids: [notification.id] })
  await refetchUserNotifications()
  if (notification.projectId && notification.topicId) {
    await navigateTo(threadRedirectRoute(notification.projectId, notification.topicId))
  }
}

const markAllRead = async () => {
  await markAllReadMutate()
  await refetchUserNotifications()
}

const clearRead = async () => {
  await clearReadMutate()
  await refetchUserNotifications()
}

const hasNotifications = computed(
  () =>
    projectsInvites.value?.length ||
    workspacesInvites.value?.length ||
    userNotifications.value.length
)
const hasUnread = computed(
  () =>
    projectsInvites.value?.length ||
    workspacesInvites.value?.length ||
    unreadCount.value
)
</script>
