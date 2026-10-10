import { CommentEvents } from '@/modules/comments/domain/events'
import { ProjectTopicsUpdatedMessageType } from '@/modules/core/graph/generated/graphql'
import type { DependenciesOf } from '@/modules/shared/helpers/factory'
import type { EventBusListen, EventPayload } from '@/modules/shared/services/eventBus'
import type { PublishSubscription } from '@/modules/shared/utils/subscriptions'
import {
  CommentSubscriptions,
  ProjectSubscriptions
} from '@/modules/shared/utils/subscriptions'

const reportCommentCreatedFactory =
  (deps: { publish: PublishSubscription }) =>
  async (payload: EventPayload<typeof CommentEvents.Created>) => {
    const { comment, resourceItems } = payload.payload

    await Promise.all([
      // @deprecated unused in FE2
      deps.publish(CommentSubscriptions.CommentActivity, {
        commentActivity: {
          type: 'comment-added',
          comment
        },
        streamId: comment.streamId,
        resourceIds: resourceItems.map((i) => i.versionId || i.objectId).join(',')
      }),
      deps.publish(ProjectSubscriptions.ProjectCommentsUpdated, {
        projectCommentsUpdated: {
          id: comment.id,
          type: ProjectTopicsUpdatedMessageType.Created,
          topic: comment,
          parentTopicId: comment.parentComment
        },
        projectId: comment.streamId,
        resourceItems
      })
    ])
  }

export const reportSubscriptionEventsFactory =
  (
    deps: {
      eventListen: EventBusListen
      publish: PublishSubscription
    } & DependenciesOf<typeof reportCommentCreatedFactory>
  ) =>
  () => {
    const reportCommentCreated = reportCommentCreatedFactory(deps)

    const quitters = [deps.eventListen(CommentEvents.Created, reportCommentCreated)]

    return () => quitters.forEach((q) => q())
  }
