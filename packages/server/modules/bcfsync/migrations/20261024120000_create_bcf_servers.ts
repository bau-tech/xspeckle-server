import type { Knex } from 'knex'

/**
 * BCF servers offered when connecting a model, managed by server admins in
 * the server settings. clientId/clientSecret are for servers without
 * automatic (RFC 7591) client registration: an OAuth client registered there
 * for this server's callback URL.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('bcf_servers', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'))
    table.text('name').notNullable()
    table.text('url').notNullable().unique()
    table.text('clientId')
    // Encrypted like the connections' secrets (services/secrets.ts).
    table.text('clientSecretEnc')
    table.specificType('createdAt', 'TIMESTAMPTZ(3)').notNullable().defaultTo(knex.fn.now())
    table.specificType('updatedAt', 'TIMESTAMPTZ(3)').notNullable().defaultTo(knex.fn.now())
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('bcf_servers')
}
