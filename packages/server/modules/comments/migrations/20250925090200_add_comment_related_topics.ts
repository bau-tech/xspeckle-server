import type { Knex } from 'knex'

const tableName = 'comment_related_topics'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable(tableName, (table) => {
    table
      .string('topicId', 10)
      .notNullable()
      .references('id')
      .inTable('comments')
      .onDelete('cascade')
    table
      .string('relatedTopicId', 10)
      .notNullable()
      .references('id')
      .inTable('comments')
      .onDelete('cascade')
    table.primary(['topicId', 'relatedTopicId'])
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable(tableName)
}
