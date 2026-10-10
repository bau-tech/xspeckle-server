import type {
  AddThreadCreatedActivity,
  AddReplyAddedActivity,
  SaveStreamActivity
} from '@/modules/activitystream/domain/operations'
import type {
  CommentCreatedActivityInput,
  ReplyCreatedActivityInput
} from '@/modules/activitystream/domain/types'
import {
  StreamActionTypes,
  StreamResourceTypes
} from '@/modules/activitystream/helpers/types'
import type { CommentEventsPayloads } from '@/modules/comments/domain/events'
import type { CommentRecord } from '@/modules/comments/helpers/types'
import { CommentEvents } from '@/modules/comments/domain/events'
import type { ReplyCreateInput } from '@/modules/core/graph/generated/graphql'
import type { EventBusListen } from '@/modules/shared/services/eventBus'
import { has } from 'lodash-es'
import type { OverrideProperties } from 'type-fest'

const addThreadCreatedActivityFactory =
  ({
    saveStreamActivity
  }: {
    saveStreamActivity: SaveStreamActivity
  }): AddThreadCreatedActivity =>
  async (params) => {
    const { input, comment } = params

    await saveStreamActivity({
      resourceId: comment.id,
      streamId: comment.streamId,
      resourceType: StreamResourceTypes.Comment,
      actionType: StreamActionTypes.Comment.Create,
      userId: comment.authorId,
      info: { input },
      message: `Comment added: ${comment.id} (${input})`
    })
  }

const isLegacyReplyCreateInput = (
  i: ReplyCreatedActivityInput
): i is ReplyCreateInput => has(i, 'streamId')

const addReplyAddedActivityFactory =
  ({
    saveStreamActivity
  }: {
    saveStreamActivity: SaveStreamActivity
  }): AddReplyAddedActivity =>
  async (params) => {
    const { input, reply } = params

    const parentCommentId = isLegacyReplyCreateInput(input)
      ? input.parentComment
      : input.topicId
    await saveStreamActivity({
      streamId: reply.streamId,
      resourceType: StreamResourceTypes.Comment,
      resourceId: parentCommentId,
      actionType: StreamActionTypes.Comment.Reply,
      userId: reply.authorId,
      info: { input },
      message: `Comment reply #${reply.id} created`
    })
  }

const isReplyCreatedPayload = (
  payload: CommentEventsPayloads[typeof CommentEvents.Created]
): payload is OverrideProperties<
  CommentEventsPayloads[typeof CommentEvents.Created],
  {
    input: ReplyCreatedActivityInput
  }
> => {
  return payload.isThread === false
}

const isThreadCreatedPayload = (
  payload: CommentEventsPayloads[typeof CommentEvents.Created]
): payload is OverrideProperties<
  CommentEventsPayloads[typeof CommentEvents.Created],
  {
    input: CommentCreatedActivityInput
  }
> => {
  return payload.isThread
}

export const reportCommentActivityFactory =
  (deps: { eventListen: EventBusListen; saveStreamActivity: SaveStreamActivity }) =>
  () => {
    const addThreadCreatedActivity = addThreadCreatedActivityFactory(deps)
    const addReplyAddedActivity = addReplyAddedActivityFactory(deps)

    // BCF sync consumers (the external BCF server) subscribe to these via webhooks to learn
    // about every change, not only creations. `info` identifies the row both
    // by Speckle id and BCF guid.
    const bcfChangeInfo = (comment: CommentRecord) => ({
      topicId: comment.parentComment || comment.id,
      commentId: comment.parentComment ? comment.id : null,
      guid: comment.guid,
      isTopic: !comment.parentComment
    })

    const quitters = [
      deps.eventListen(CommentEvents.Created, async ({ payload }) => {
        if (isReplyCreatedPayload(payload)) {
          await addReplyAddedActivity({
            reply: payload.comment,
            input: payload.input
          })
        } else if (isThreadCreatedPayload(payload)) {
          await addThreadCreatedActivity(payload)
        }
      }),
      deps.eventListen(CommentEvents.Updated, async ({ payload }) => {
        const comment = payload.newComment
        await deps.saveStreamActivity({
          streamId: comment.streamId,
          resourceType: StreamResourceTypes.Comment,
          resourceId: comment.parentComment || comment.id,
          actionType: StreamActionTypes.Comment.Update,
          userId: payload.userId ?? comment.authorId,
          info: bcfChangeInfo(comment),
          message: `Comment updated: ${comment.id}`
        })
      }),
      deps.eventListen(CommentEvents.Deleted, async ({ payload }) => {
        const comment = payload.comment
        await deps.saveStreamActivity({
          streamId: comment.streamId,
          resourceType: StreamResourceTypes.Comment,
          resourceId: comment.parentComment || comment.id,
          actionType: StreamActionTypes.Comment.Delete,
          userId: payload.userId ?? comment.authorId,
          info: bcfChangeInfo(comment),
          message: `Comment deleted: ${comment.id}`
        })
      })
    ]

    return () => {
      quitters.forEach((quit) => quit())
    }
  }
