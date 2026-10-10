import type { Knex } from 'knex'

const tableName = 'comment_document_references'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable(tableName, (table) => {
    table.string('id', 10).primary()
    table
      .string('topicId', 10)
      .notNullable()
      .references('id')
      .inTable('comments')
      .onDelete('cascade')
      .index()
    table.text('documentGuid').defaultTo(null)
    table.text('url').defaultTo(null)
    table.text('description').defaultTo(null)
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable(tableName)
}
