import type { Knex } from 'knex'

const tableName = 'comments'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable(tableName, (table) => {
    table.dropColumn('archived')
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable(tableName, (table) => {
    table.boolean('archived').notNullable().defaultTo(false)
  })
}
