import { buildTableHelper } from '@/modules/core/dbSchema'
import type { Knex } from 'knex'

export const BcfServers = buildTableHelper('bcf_servers', [
  'id',
  'name',
  'url',
  'clientId',
  'clientSecretEnc',
  'createdAt',
  'updatedAt'
])

export interface BcfServerRecord {
  id: string
  name: string
  url: string
  clientId: string | null
  clientSecretEnc: string | null
  createdAt: Date
  updatedAt: Date
}

const tbl = (db: Knex) => db<BcfServerRecord>(BcfServers.name)

export const listBcfServersFactory = (deps: { db: Knex }) => async () =>
  await tbl(deps.db).orderBy('name', 'asc')

export const getBcfServerFactory = (deps: { db: Knex }) => async (id: string) =>
  await tbl(deps.db).where({ id }).first()

export const getBcfServerByUrlFactory = (deps: { db: Knex }) => async (url: string) =>
  await tbl(deps.db).where({ url }).first()

export const insertBcfServerFactory =
  (deps: { db: Knex }) =>
  async (input: Pick<BcfServerRecord, 'name' | 'url' | 'clientId' | 'clientSecretEnc'>) => {
    const [row] = await tbl(deps.db).insert(input, '*')
    return row
  }

export const updateBcfServerFactory =
  (deps: { db: Knex }) =>
  async (
    id: string,
    update: Partial<Pick<BcfServerRecord, 'name' | 'url' | 'clientId' | 'clientSecretEnc'>>
  ) => {
    const [row] = await tbl(deps.db)
      .where({ id })
      .update({ ...update, updatedAt: new Date() }, '*')
    return row as BcfServerRecord | undefined
  }

export const deleteBcfServerFactory = (deps: { db: Knex }) => async (id: string) =>
  (await tbl(deps.db).where({ id }).delete()) > 0
