import type { Knex } from 'knex'

/**
 * The BCF server's value lists for the connected project (its extensions:
 * users a topic can be assigned to, types, statuses, ...), refreshed on
 * every sync and offered in the viewer.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('bcf_server_connections', (table) => {
    table.jsonb('remoteExtensions')
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('bcf_server_connections', (table) => {
    table.dropColumn('remoteExtensions')
  })
}
