import { buildTableHelper } from '@/modules/core/dbSchema'
import type { BcfServerConnectionRecord } from '@/modules/bcfsync/domain/types'
import type { Knex } from 'knex'

export const BcfServerConnections = buildTableHelper('bcf_server_connections', [
  'id',
  'projectId',
  'modelId',
  'createdBy',
  'name',
  'baseUrl',
  'server',
  'clientId',
  'clientSecretEnc',
  'accessTokenEnc',
  'refreshTokenEnc',
  'accessTokenExpiresAt',
  'oauthState',
  'oauthVerifier',
  'oauthStartedAt',
  'oauthReturnTo',
  'remoteProjectId',
  'remoteProjectName',
  'direction',
  'status',
  'lastError',
  'lastSyncAt',
  'pullCursor',
  'lastSyncResult',
  'remoteExtensions',
  'createdAt',
  'updatedAt'
])

const tbl = (db: Knex) => db<BcfServerConnectionRecord>(BcfServerConnections.name)

export type NewBcfServerConnection = Pick<
  BcfServerConnectionRecord,
  | 'projectId'
  | 'modelId'
  | 'createdBy'
  | 'name'
  | 'baseUrl'
  | 'server'
  | 'clientId'
  | 'clientSecretEnc'
  | 'oauthState'
  | 'oauthVerifier'
  | 'oauthReturnTo'
  | 'direction'
> & { oauthStartedAt: Date }

export const insertBcfConnectionFactory =
  (deps: { db: Knex }) =>
  async (input: NewBcfServerConnection): Promise<BcfServerConnectionRecord> => {
    const [row] = await tbl(deps.db).insert(input, '*')
    return row
  }

export const getBcfConnectionFactory =
  (deps: { db: Knex }) =>
  async (id: string): Promise<BcfServerConnectionRecord | undefined> =>
    await tbl(deps.db).where({ id }).first()

export const getBcfConnectionByStateFactory =
  (deps: { db: Knex }) =>
  async (oauthState: string): Promise<BcfServerConnectionRecord | undefined> =>
    await tbl(deps.db).where({ oauthState }).first()

export const getProjectBcfConnectionsFactory =
  (deps: { db: Knex }) =>
  async (projectId: string): Promise<BcfServerConnectionRecord[]> =>
    await tbl(deps.db).where({ projectId }).orderBy('createdAt', 'asc')

export const updateBcfConnectionFactory =
  (deps: { db: Knex }) =>
  async (
    id: string,
    update: Partial<Omit<BcfServerConnectionRecord, 'id' | 'createdAt'>>
  ): Promise<BcfServerConnectionRecord | undefined> => {
    const [row] = await tbl(deps.db)
      .where({ id })
      .update({ ...update, updatedAt: new Date() }, '*')
    return row
  }

export const deleteBcfConnectionFactory =
  (deps: { db: Knex }) =>
  async (id: string): Promise<boolean> =>
    (await tbl(deps.db).where({ id }).delete()) > 0

/** The connection of a model to a project on a BCF server, if any. */
export const getBcfConnectionForTargetFactory =
  (deps: { db: Knex }) =>
  async (target: { modelId: string; baseUrl: string; remoteProjectId: string }) =>
    await tbl(deps.db).where(target).first()

/** A project's connections that have a BCF project chosen. */
export const getProjectBcfConnectionsWithProjectFactory =
  (deps: { db: Knex }) =>
  async (projectId: string): Promise<BcfServerConnectionRecord[]> =>
    await tbl(deps.db).where({ projectId }).whereNotNull('remoteProjectId')

/** A project's syncing connections (status active). */
export const getProjectActiveBcfConnectionsFactory =
  (deps: { db: Knex }) =>
  async (projectId: string): Promise<BcfServerConnectionRecord[]> =>
    await tbl(deps.db)
      .where({ projectId, status: 'active' })
      .whereNotNull('remoteProjectId')

/** Connections the scheduled sync runs for. */
export const getActiveBcfConnectionsFactory =
  (deps: { db: Knex }) =>
  async (): Promise<BcfServerConnectionRecord[]> =>
    await tbl(deps.db)
      .where({ status: 'active' })
      .whereNotNull('remoteProjectId')
