import type { Knex } from 'knex'

const tableName = 'comments'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable(tableName, (table) => {
    table.text('title').defaultTo(null)
    table.text('topicType').defaultTo(null)
    table.text('topicStatus').defaultTo(null)
    table.text('priority').defaultTo(null)
    table.text('stage').defaultTo(null)
    table.specificType('labels', 'text[]').defaultTo(null)
    table.specificType('dueDate', 'TIMESTAMPTZ(3)').defaultTo(null)
    table.text('assignedTo').defaultTo(null)
    table.integer('index').defaultTo(null)
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable(tableName, (table) => {
    table.dropColumn('title')
    table.dropColumn('topicType')
    table.dropColumn('topicStatus')
    table.dropColumn('priority')
    table.dropColumn('stage')
    table.dropColumn('labels')
    table.dropColumn('dueDate')
    table.dropColumn('assignedTo')
    table.dropColumn('index')
  })
}
