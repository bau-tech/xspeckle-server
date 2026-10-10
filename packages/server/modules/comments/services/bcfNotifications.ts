import { CommentEvents } from '@/modules/comments/domain/events'
import type { CommentRecord } from '@/modules/comments/helpers/types'
import type {
  CreateUserNotification,
  DeleteTopicUserNotifications,
  FindProjectCollaboratorByEmail
} from '@/modules/notifications/domain/operations'
import { UserNotificationType } from '@/modules/notifications/helpers/types'
import type { EventBus } from '@/modules/shared/services/eventBus'
import type { Logger } from 'pino'

const sameIdentity = (a: string | null, b: string | null) =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase()

/**
 * In-app "assigned to you" notifications for BCF topics -- the same rule as
 * the external BCF server's: fire when a topic is created with an
 * assignee or its assignee changes, except for someone assigning themselves.
 * That server keeps sending the email (it notifies on topics synced in from here
 * too), so this only feeds Speckle's bell.
 *
 * `assignedTo` is a free-text BCF identity (an email), so it only reaches a
 * Speckle user whose account email matches and who collaborates on the
 * project -- anyone else would just see a topic they can't open.
 */
export const notifyBcfAssigneesOnCommentEventsFactory =
  (deps: {
    eventBus: EventBus
    findProjectCollaboratorByEmail: FindProjectCollaboratorByEmail
    createUserNotification: CreateUserNotification
    deleteTopicUserNotifications: DeleteTopicUserNotifications
    logger: Logger
  }) =>
  () => {
    const notifyAssignee = async (params: {
      topic: CommentRecord
      previousAssignee: string | null
      /** BCF identity of whoever made the change. */
      actor: string | null
    }) => {
      const { topic, previousAssignee, actor } = params
      const assignee = topic.assignedTo?.trim()
      if (topic.parentComment || !assignee) return
      if (sameIdentity(assignee, previousAssignee)) return
      if (sameIdentity(assignee, actor)) return

      const userId = await deps.findProjectCollaboratorByEmail({
        projectId: topic.streamId,
        email: assignee
      })
      if (!userId) return

      await deps.createUserNotification({
        userId,
        type: UserNotificationType.BcfTopicAssigned,
        payload: {
          projectId: topic.streamId,
          topicId: topic.id,
          topicGuid: topic.guid,
          topicTitle: topic.title || '(untitled)',
          actor
        }
      })
    }

    // A failed notification must never fail the topic write that triggered it
    const safely =
      <A extends unknown[]>(fn: (...args: A) => Promise<unknown>) =>
      async (...args: A) => {
        try {
          await fn(...args)
        } catch (e) {
          deps.logger.warn({ err: e }, 'Failed to update BCF topic notifications')
        }
      }

    const exitCbs = [
      deps.eventBus.listen(
        CommentEvents.Created,
        safely(async ({ payload: { comment } }) =>
          notifyAssignee({
            topic: comment,
            previousAssignee: null,
            actor: comment.creationAuthor
          })
        )
      ),
      deps.eventBus.listen(
        CommentEvents.Updated,
        safely(async ({ payload: { newComment, previousComment } }) =>
          notifyAssignee({
            topic: newComment,
            previousAssignee: previousComment.assignedTo,
            actor: newComment.modifiedAuthor
          })
        )
      ),
      deps.eventBus.listen(
        CommentEvents.Deleted,
        safely(async ({ payload: { comment } }) => {
          if (!comment.parentComment)
            await deps.deleteTopicUserNotifications(comment.id)
        })
      )
    ]

    return () => exitCbs.forEach((cb) => cb())
  }
