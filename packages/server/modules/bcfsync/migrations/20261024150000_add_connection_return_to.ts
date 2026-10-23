import type { Knex } from 'knex'

/** Where to send the user back to after signing in at the BCF server. */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('bcf_server_connections', (table) => {
    table.text('oauthReturnTo')
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('bcf_server_connections', (table) => {
    table.dropColumn('oauthReturnTo')
  })
}
