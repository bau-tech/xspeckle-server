import type {
  NotificationPreferences,
  UserNotificationPayloadMap,
  UserNotificationRecord,
  UserNotificationType
} from '@/modules/notifications/helpers/types'

export type GetSavedUserNotificationPreferences = (
  userId: string
) => Promise<NotificationPreferences>

export type SaveUserNotificationPreferences = (
  userId: string,
  preferences: NotificationPreferences
) => Promise<void>

export type GetUserNotificationPreferences = (
  userId: string
) => Promise<NotificationPreferences>

export type CreateUserNotification = <T extends UserNotificationType>(params: {
  userId: string
  type: T
  payload: UserNotificationPayloadMap[T]
}) => Promise<UserNotificationRecord<T>>

export type GetUserNotifications = (params: {
  userId: string
  unreadOnly?: boolean
  limit: number
}) => Promise<UserNotificationRecord[]>

export type CountUnreadUserNotifications = (userId: string) => Promise<number>

/** Returns how many notifications changed. */
export type MarkUserNotificationsRead = (params: {
  userId: string
  /** All of the user's unread notifications when omitted. */
  ids?: string[]
}) => Promise<number>

/** Deletes the user's already read notifications, returns how many. */
export type ClearReadUserNotifications = (userId: string) => Promise<number>

/** Drops every notification about a topic, e.g. once it has been deleted. */
export type DeleteTopicUserNotifications = (topicId: string) => Promise<number>

/**
 * The project collaborator whose account email is `email` (case-insensitive) --
 * how a BCF assignee (a plain email, as on the external BCF server) maps to a Speckle user.
 */
export type FindProjectCollaboratorByEmail = (params: {
  projectId: string
  email: string
}) => Promise<string | null>
