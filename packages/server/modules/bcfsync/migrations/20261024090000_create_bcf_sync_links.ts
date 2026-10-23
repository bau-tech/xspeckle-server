import type { Knex } from 'knex'

/**
 * What a connection last synced, per item: each side's normalised content
 * at that moment. A side whose content now differs from its own entry has
 * changed since; a linked item missing on one side was deleted there.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('bcf_sync_links', (table) => {
    table
      .uuid('connectionId')
      .notNullable()
      .references('id')
      .inTable('bcf_server_connections')
      .onDelete('cascade')
    // 'topic' | 'comment' | 'viewpoint'
    table.string('kind', 16).notNullable()
    table.uuid('guid').notNullable()
    table.uuid('topicGuid')
    table.jsonb('localState')
    table.jsonb('remoteState')
    table.specificType('syncedAt', 'TIMESTAMPTZ(3)').notNullable().defaultTo(knex.fn.now())
    table.primary(['connectionId', 'kind', 'guid'])
  })
  await knex.schema.alterTable('bcf_server_connections', (table) => {
    // Summary of the last run, for the UI.
    table.jsonb('lastSyncResult')
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('bcf_server_connections', (table) => {
    table.dropColumn('lastSyncResult')
  })
  await knex.schema.dropTable('bcf_sync_links')
}
