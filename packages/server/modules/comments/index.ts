import { db } from '@/db/knex'
import { moduleLogger } from '@/observability/logging'
import { saveStreamActivityFactory } from '@/modules/activitystream/repositories'
import { reportSubscriptionEventsFactory } from '@/modules/comments/events/subscriptionListeners'
import { notifyUsersOnCommentEventsFactory } from '@/modules/comments/services/notifications'
import { notifyBcfAssigneesOnCommentEventsFactory } from '@/modules/comments/services/bcfNotifications'
import {
  createUserNotificationFactory,
  deleteTopicUserNotificationsFactory,
  findProjectCollaboratorByEmailFactory
} from '@/modules/notifications/repositories'
import { publishNotification } from '@/modules/notifications/services/publication'
import type { Optional, SpeckleModule } from '@/modules/shared/helpers/typeHelper'
import { getEventBus } from '@/modules/shared/services/eventBus'
import { getBcfRouter } from '@/modules/comments/rest/bcf'
import { publish } from '@/modules/shared/utils/subscriptions'

let unsubFromEvents: Optional<() => void> = undefined
let unsubFromBcfEvents: Optional<() => void> = undefined

const commentsModule: SpeckleModule = {
  async init({ app, isInitial }) {
    moduleLogger.info('🗣  Init comments module')
    app.use(getBcfRouter())

    if (isInitial) {
      const notifyUsersOnCommentEvents = notifyUsersOnCommentEventsFactory({
        eventBus: getEventBus(),
        publish: publishNotification,
        saveActivity: saveStreamActivityFactory({ db })
      })
      unsubFromEvents = await notifyUsersOnCommentEvents()

      unsubFromBcfEvents = notifyBcfAssigneesOnCommentEventsFactory({
        eventBus: getEventBus(),
        findProjectCollaboratorByEmail: findProjectCollaboratorByEmailFactory({ db }),
        createUserNotification: createUserNotificationFactory({ db }),
        deleteTopicUserNotifications: deleteTopicUserNotificationsFactory({ db }),
        logger: moduleLogger
      })()

      reportSubscriptionEventsFactory({
        eventListen: getEventBus().listen,
        publish
      })()
    }
  },
  async finalize() {},
  async shutdown() {
    unsubFromEvents?.()
    unsubFromEvents = undefined
    unsubFromBcfEvents?.()
    unsubFromBcfEvents = undefined
  }
}

export default commentsModule
