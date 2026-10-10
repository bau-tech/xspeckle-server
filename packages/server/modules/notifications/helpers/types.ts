/* eslint-disable @typescript-eslint/no-explicit-any */
import type { StreamAccessRequestRecord } from '@/modules/accessrequests/repositories'
import type { MaybeAsync, Optional } from '@/modules/shared/helpers/typeHelper'
import type { Job } from 'bull'
import { isObject, has } from 'lodash-es'
import type { Logger } from 'pino'

export enum NotificationType {
  ActivityDigest = 'activityDigest',
  MentionedInComment = 'mentionedInComment',
  NewStreamAccessRequest = 'newStreamAccessRequest',
  StreamAccessRequestApproved = 'streamAccessRequestApproved'
}

export enum NotificationChannel {
  Email = 'email'
}

export type NotificationPreferences = Partial<
  Record<NotificationType, Partial<Record<NotificationChannel, boolean>>>
>

export type UserNotificationPreferencesRecord = {
  userId: string
  preferences: NotificationPreferences
}

// Add mappings between NotificationTypes and expected Message types here
export type NotificationTypeMessageMap = {
  [NotificationType.MentionedInComment]: MentionedInCommentMessage
  [NotificationType.NewStreamAccessRequest]: NewStreamAccessRequestMessage
  [NotificationType.StreamAccessRequestApproved]: StreamAccessRequestApprovedMessage
  [NotificationType.ActivityDigest]: ActivityDigestMessage
} & { [k in NotificationType]: unknown }

export type NotificationMessage<
  T extends NotificationType = any,
  P extends Optional<Record<string, unknown>> = any
> = {
  targetUserId: string
  type: T
  data: P
}

export type NotificationHandler<M extends NotificationMessage = NotificationMessage> = (
  msg: M,
  extra: {
    job: Job
    logger: Logger
  }
) => MaybeAsync<void>

// Mapping between all notification type values and their corresponding handler types
export type NotificationTypeHandlers = {
  [k in NotificationType]: NotificationHandler<NotificationTypeMessageMap[k]>
}

export const isNotificationMessage = (msg: unknown): msg is NotificationMessage =>
  isObject(msg) && has(msg, 'targetUserId') && has(msg, 'type') && has(msg, 'data')

export type NotificationPublisher = <T extends NotificationType>(
  type: T,
  params: Omit<NotificationTypeMessageMap[T], 'type'>
) => Promise<string | number>

export type MentionedInCommentData = {
  threadId: string
  commentId: string
  authorId: string
  streamId: string
}

export type MentionedInCommentMessage = NotificationMessage<
  NotificationType.MentionedInComment,
  MentionedInCommentData
>

export type NewStreamAccessRequestData = { requestId: string }

export type NewStreamAccessRequestMessage = NotificationMessage<
  NotificationType.NewStreamAccessRequest,
  NewStreamAccessRequestData
>

export type StreamAccessRequestApprovedData = {
  /**
   * Approved (and since then deleted) request object
   */
  request: StreamAccessRequestRecord
  /**
   * ID of user who finalized the request
   */
  finalizedBy: string
}

export type StreamAccessRequestApprovedMessage = NotificationMessage<
  NotificationType.StreamAccessRequestApproved,
  StreamAccessRequestApprovedData
>

export type ActivityDigestData = {
  streamIds: string[]
  start: Date
  end: Date
}

export type ActivityDigestMessage = NotificationMessage<
  NotificationType.ActivityDigest,
  ActivityDigestData
>

/**
 * In-app notifications (the header bell), stored in user_notifications. Separate
 * from the Bull-queued NotificationType above, which only drives emails.
 */
export const UserNotificationType = {
  /**
   * A BCF topic got assigned to the user -- same event, recipient rule and message
   * as the external BCF server's bell, so the two feeds agree. That server also
   * sends the email for it, Speckle doesn't.
   */
  BcfTopicAssigned: 'bcfTopicAssigned'
} as const

export type UserNotificationType =
  (typeof UserNotificationType)[keyof typeof UserNotificationType]

export type BcfTopicAssignedPayload = {
  projectId: string
  topicId: string
  topicGuid: string
  /** Topic title when the notification was created. */
  topicTitle: string
  /** BCF identity (an email) of whoever made the assignment, if known. */
  actor: string | null
}

export type UserNotificationPayloadMap = {
  [UserNotificationType.BcfTopicAssigned]: BcfTopicAssignedPayload
}

export type UserNotificationRecord<
  T extends UserNotificationType = UserNotificationType
> = {
  id: string
  type: T
  read: boolean
  userId: string
  payload: UserNotificationPayloadMap[T]
  version: string
  sendEmailAt: Date | null
  createdAt: Date
  updatedAt: Date
}
