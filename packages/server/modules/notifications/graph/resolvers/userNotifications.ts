import { db } from '@/db/knex'
import type { Resolvers } from '@/modules/core/graph/generated/graphql'
import { getUserByEmailFactory } from '@/modules/core/repositories/users'
import {
  clearReadUserNotificationsFactory,
  countUnreadUserNotificationsFactory,
  getUserNotificationsFactory,
  markUserNotificationsReadFactory
} from '@/modules/notifications/repositories'
import type { UserNotificationRecord } from '@/modules/notifications/helpers/types'
import { UserNotificationType } from '@/modules/notifications/helpers/types'
import { clamp } from 'lodash-es'

const getUserNotifications = getUserNotificationsFactory({ db })
const countUnreadUserNotifications = countUnreadUserNotificationsFactory({ db })
const markUserNotificationsRead = markUserNotificationsReadFactory({ db })
const clearReadUserNotifications = clearReadUserNotificationsFactory({ db })
const getUserByEmail = getUserByEmailFactory({ db })

const isBcfTopicAssigned = (
  n: UserNotificationRecord
): n is UserNotificationRecord<typeof UserNotificationType.BcfTopicAssigned> =>
  n.type === UserNotificationType.BcfTopicAssigned

/** The actor's Speckle name when their BCF identity is a known account email. */
const resolveActorName = async (n: UserNotificationRecord) => {
  const actor = n.payload.actor
  if (!actor) return null
  const user = await getUserByEmail(actor)
  return user?.name || actor
}

export default {
  User: {
    async notifications(parent, args) {
      return await getUserNotifications({
        userId: parent.id,
        unreadOnly: args.unreadOnly,
        limit: clamp(args.limit, 1, 100)
      })
    },
    async unreadNotificationCount(parent) {
      return await countUnreadUserNotifications(parent.id)
    }
  },
  UserNotification: {
    projectId: (parent) => parent.payload.projectId,
    topicId: (parent) => (isBcfTopicAssigned(parent) ? parent.payload.topicId : null),
    topicGuid: (parent) =>
      isBcfTopicAssigned(parent) ? parent.payload.topicGuid : null,
    topicTitle: (parent) =>
      isBcfTopicAssigned(parent) ? parent.payload.topicTitle : null,
    actorName: (parent) => resolveActorName(parent),
    async message(parent) {
      if (isBcfTopicAssigned(parent)) {
        const actor = (await resolveActorName(parent)) || 'Someone'
        return `${actor} assigned you to "${parent.payload.topicTitle}"`
      }
      return 'New notification'
    }
  },
  ActiveUserMutations: {
    notifications: () => ({})
  },
  UserNotificationMutations: {
    async markRead(_parent, args, ctx) {
      if (!args.ids.length) return 0
      return await markUserNotificationsRead({ userId: ctx.userId!, ids: args.ids })
    },
    async markAllRead(_parent, _args, ctx) {
      return await markUserNotificationsRead({ userId: ctx.userId! })
    },
    async clearRead(_parent, _args, ctx) {
      return await clearReadUserNotifications(ctx.userId!)
    }
  }
} as Resolvers
