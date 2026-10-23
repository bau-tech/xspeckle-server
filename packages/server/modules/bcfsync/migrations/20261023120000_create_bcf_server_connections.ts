import type { Knex } from 'knex'

const tableName = 'bcf_server_connections'

/**
 * A link between one Speckle model and one project on an external BCF server.
 * The unit of sync is a model, as BCF servers model a "project" as one body
 * of coordination issues. A model can have several connections (different
 * servers); sync state is kept per connection.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable(tableName, (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'))
    table
      .string('projectId', 10)
      .notNullable()
      .references('id')
      .inTable('streams')
      .onDelete('cascade')
      .index()
    // No FK: models (branches) live in the project's own (possibly regional)
    // database, this table in the main one.
    table.string('modelId', 10).notNullable()
    table.string('createdBy', 10).references('id').inTable('users').onDelete('set null')

    table.text('name').notNullable().defaultTo('')
    table.text('baseUrl').notNullable()
    // Discovered endpoints, kept so a sync does not need to rediscover.
    table.jsonb('server').notNullable()

    table.text('clientId').notNullable()
    // Secrets are stored encrypted (AES-256-GCM, key derived from SESSION_SECRET).
    table.text('clientSecretEnc')
    table.text('accessTokenEnc')
    table.text('refreshTokenEnc')
    table.specificType('accessTokenExpiresAt', 'TIMESTAMPTZ(3)')

    // One-shot OAuth state while the user signs in at the BCF server.
    table.text('oauthState').unique()
    table.text('oauthVerifier')
    table.specificType('oauthStartedAt', 'TIMESTAMPTZ(3)')

    table.text('remoteProjectId')
    table.text('remoteProjectName')

    // 'two-way' | 'pull' | 'push'
    table.string('direction', 16).notNullable().defaultTo('two-way')
    // 'pending' (signing in) | 'authorized' (pick remote project) | 'active' | 'error' | 'disabled'
    table.string('status', 16).notNullable().defaultTo('pending')
    table.text('lastError')
    table.specificType('lastSyncAt', 'TIMESTAMPTZ(3)')
    table.specificType('pullCursor', 'TIMESTAMPTZ(3)')

    table.specificType('createdAt', 'TIMESTAMPTZ(3)').notNullable().defaultTo(knex.fn.now())
    table.specificType('updatedAt', 'TIMESTAMPTZ(3)').notNullable().defaultTo(knex.fn.now())

    table.index(['projectId', 'modelId'])
  })
  // One connection per (model, server, remote project).
  await knex.raw(
    `CREATE UNIQUE INDEX bcf_server_connections_target_uq
     ON ${tableName} ("modelId", "baseUrl", "remoteProjectId")
     WHERE "remoteProjectId" IS NOT NULL`
  )
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable(tableName)
}
