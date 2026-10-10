import type { Knex } from 'knex'

const tableName = 'topic_viewpoints'

// A Topic/Comment row's own `data`/`screenshot` columns still back its
// single, original creation-time viewpoint (topic.viewpoint/comment.viewpoint,
// unchanged) -- this table is additional, independently-identified storage so
// a topic can carry more than one saved viewpoint over its lifetime, each
// with its own guid, matching real BCF's viewpoint-per-.bcfv-file model.
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
    table.string('authorId', 10).references('id').inTable('users').onDelete('set null')
    table.jsonb('data').notNullable()
    table.text('screenshot')
    table.specificType('createdAt', 'TIMESTAMPTZ(3)').defaultTo(knex.fn.now())
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable(tableName)
}
