import {
  ServerAcl,
  StreamAcl,
  UserEmails,
  UserNotificationPreferences,
  UserNotifications
} from '@/modules/core/dbSchema'
import { Roles } from '@/modules/core/helpers/mainConstants'
import type {
  ClearReadUserNotifications,
  CountUnreadUserNotifications,
  CreateUserNotification,
  DeleteTopicUserNotifications,
  FindProjectCollaboratorByEmail,
  GetSavedUserNotificationPreferences,
  GetUserNotifications,
  MarkUserNotificationsRead,
  SaveUserNotificationPreferences
} from '@/modules/notifications/domain/operations'
import type {
  NotificationPreferences,
  UserNotificationPreferencesRecord,
  UserNotificationRecord
} from '@/modules/notifications/helpers/types'
import cryptoRandomString from 'crypto-random-string'
import type { Knex } from 'knex'

const tables = {
  userNotificationPreferences: (db: Knex) =>
    db<UserNotificationPreferencesRecord>(UserNotificationPreferences.name),
  userNotifications: (db: Knex) => db<UserNotificationRecord>(UserNotifications.name)
}

/** Bumped when a payload shape changes incompatibly. */
const USER_NOTIFICATION_VERSION = '1'

export const getSavedUserNotificationPreferencesFactory =
  (deps: { db: Knex }): GetSavedUserNotificationPreferences =>
  async (userId: string): Promise<NotificationPreferences> => {
    const userPreferences = await tables
      .userNotificationPreferences(deps.db)
      .where({ userId })
      .first()

    return userPreferences?.preferences ?? {}
  }

export const saveUserNotificationPreferencesFactory =
  (deps: { db: Knex }): SaveUserNotificationPreferences =>
  async (userId: string, preferences: NotificationPreferences): Promise<void> => {
    await tables
      .userNotificationPreferences(deps.db)
      .insert({ userId, preferences })
      .onConflict('userId')
      .merge()
  }

export const createUserNotificationFactory =
  (deps: { db: Knex }): CreateUserNotification =>
  async ({ userId, type, payload }) => {
    const [row] = await tables
      .userNotifications(deps.db)
      .insert({
        id: cryptoRandomString({ length: 10 }),
        type,
        read: false,
        userId,
        payload,
        version: USER_NOTIFICATION_VERSION
      })
      .returning('*')
    return row as UserNotificationRecord<typeof type>
  }

export const getUserNotificationsFactory =
  (deps: { db: Knex }): GetUserNotifications =>
  async ({ userId, unreadOnly, limit }) => {
    const q = tables
      .userNotifications(deps.db)
      .where({ [UserNotifications.col.userId]: userId })
      .orderBy(UserNotifications.col.createdAt, 'desc')
      .limit(limit)
    if (unreadOnly) q.andWhere({ [UserNotifications.col.read]: false })
    return await q
  }

export const countUnreadUserNotificationsFactory =
  (deps: { db: Knex }): CountUnreadUserNotifications =>
  async (userId) => {
    const [res] = await tables
      .userNotifications(deps.db)
      .where({
        [UserNotifications.col.userId]: userId,
        [UserNotifications.col.read]: false
      })
      .count()
    return parseInt(String(res.count))
  }

export const markUserNotificationsReadFactory =
  (deps: { db: Knex }): MarkUserNotificationsRead =>
  async ({ userId, ids }) => {
    const q = tables.userNotifications(deps.db).where({
      [UserNotifications.col.userId]: userId,
      [UserNotifications.col.read]: false
    })
    if (ids) q.whereIn(UserNotifications.col.id, ids)
    return await q.update({ read: true, updatedAt: new Date() })
  }

export const clearReadUserNotificationsFactory =
  (deps: { db: Knex }): ClearReadUserNotifications =>
  async (userId) =>
    await tables
      .userNotifications(deps.db)
      .where({
        [UserNotifications.col.userId]: userId,
        [UserNotifications.col.read]: true
      })
      .delete()

export const deleteTopicUserNotificationsFactory =
  (deps: { db: Knex }): DeleteTopicUserNotifications =>
  async (topicId) =>
    await tables
      .userNotifications(deps.db)
      .whereRaw(`${UserNotifications.col.payload} ->> 'topicId' = ?`, [topicId])
      .delete()

export const findProjectCollaboratorByEmailFactory =
  (deps: { db: Knex }): FindProjectCollaboratorByEmail =>
  async ({ projectId, email }) => {
    const row = await deps
      .db(UserEmails.name)
      .select<{ userId: string }>(UserEmails.col.userId)
      .innerJoin(StreamAcl.name, StreamAcl.col.userId, UserEmails.col.userId)
      .innerJoin(ServerAcl.name, ServerAcl.col.userId, UserEmails.col.userId)
      .where(StreamAcl.col.resourceId, projectId)
      .whereNot(ServerAcl.col.role, Roles.Server.ArchivedUser)
      .whereRaw(`lower(${UserEmails.col.email}) = lower(?)`, [email.trim()])
      .first()
    return row?.userId ?? null
  }
