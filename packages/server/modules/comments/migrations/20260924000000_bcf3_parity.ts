import type { Knex } from 'knex'

/**
 * Brings Topic/Comment/Viewpoint storage to BCF 3.0 parity with the external
 * BCF server so the two can be synced 1:1:
 *
 * - every Topic, Comment and Viewpoint gets a BCF `guid` -- the identity the
 *   sync matches both sides on (Speckle's own 10-char ids stay the primary
 *   keys; guid is the portable, client-assignable one BCF 3.0 requires).
 * - BCF's string identities and dates (creation_author, modified_author,
 *   modified_date) and the remaining topic fields (reference_links,
 *   bim_snippet).
 * - a Comment references one of its topic's viewpoints by guid, as BCF
 *   does, instead of embedding its own.
 * - viewpoints become a single flat list: a row's own creation-time
 *   viewpoint (its `data`/`screenshot` columns) is copied into
 *   topic_viewpoints, so topic_viewpoints is the only place viewpoints live.
 *   The row's `data` stays -- it's the Speckle viewer's own anchoring state,
 *   not a BCF concept.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('comments', (table) => {
    table.uuid('guid').notNullable().defaultTo(knex.raw('gen_random_uuid()')).unique()
    table.text('creationAuthor').defaultTo(null)
    table.text('modifiedAuthor').defaultTo(null)
    table.specificType('modifiedDate', 'TIMESTAMPTZ(3)').defaultTo(null)
    table.specificType('referenceLinks', 'text[]').defaultTo(null)
    table.jsonb('bimSnippet').defaultTo(null)
    table.uuid('viewpointGuid').defaultTo(null)
  })

  await knex.schema.alterTable('comment_document_references', (table) => {
    table.uuid('guid').notNullable().defaultTo(knex.raw('gen_random_uuid()')).unique()
  })

  await knex.schema.alterTable('topic_viewpoints', (table) => {
    table.uuid('guid').notNullable().defaultTo(knex.raw('gen_random_uuid()')).unique()
    table.integer('index').defaultTo(null)
    // The BCF 3.0 viewpoint itself (cameras, lines, clipping_planes,
    // components), stored in the spec's own snake_case wire shape so nothing
    // is lost in either direction. Null for viewpoints captured in the
    // Speckle viewer before this migration -- derived from `data` on read.
    table.jsonb('bcf').defaultTo(null)
    table.text('snapshotType').defaultTo(null)
  })
  // A viewpoint that arrives BCF-only (e.g. synced from the external BCF server) has no
  // Speckle viewer state until one is derived from it.
  await knex.raw('ALTER TABLE topic_viewpoints ALTER COLUMN data DROP NOT NULL')

  const hasUsers = await knex.schema.hasTable('users')
  if (hasUsers) {
    await knex.raw(`
      UPDATE comments c SET "creationAuthor" = u.email
      FROM users u WHERE u.id = c."authorId" AND c."creationAuthor" IS NULL
    `)
  }

  // Copy every row's own creation-time viewpoint into topic_viewpoints.
  // Replies go to their topic's list and then point at it via viewpointGuid.
  await knex.raw(`
    INSERT INTO topic_viewpoints (id, "topicId", "authorId", data, screenshot, "createdAt", guid)
    SELECT substr(md5(random()::text || c.id), 1, 10),
           COALESCE(c."parentComment", c.id), c."authorId", c.data, c.screenshot,
           c."createdAt", gen_random_uuid()
    FROM comments c
    WHERE jsonb_typeof(c.data) = 'object'
      AND c.data -> 'version' IS NOT NULL AND c.data -> 'state' IS NOT NULL
  `)
  await knex.raw(`
    UPDATE comments c SET "viewpointGuid" = v.guid
    FROM topic_viewpoints v
    WHERE c."parentComment" IS NOT NULL
      AND v."topicId" = c."parentComment"
      AND v."createdAt" = c."createdAt"
      AND v."authorId" IS NOT DISTINCT FROM c."authorId"
  `)
  await knex.raw(`
    UPDATE topic_viewpoints v SET index = o.rn
    FROM (
      SELECT id, row_number() OVER (PARTITION BY "topicId" ORDER BY "createdAt", id) AS rn
      FROM topic_viewpoints
    ) o
    WHERE o.id = v.id
  `)
}

export async function down(knex: Knex): Promise<void> {
  // Undo the copies made by up(): a reply's copy is the one it points at, a
  // topic's copy shares the topic row's own createdAt (a viewpoint added via
  // createViewpoint is always later than its topic). BCF-only viewpoints
  // (no `data`) can't satisfy the restored NOT NULL, so they go too.
  await knex.raw(`
    DELETE FROM topic_viewpoints WHERE guid IN (
      SELECT "viewpointGuid" FROM comments WHERE "viewpointGuid" IS NOT NULL
    )
  `)
  await knex.raw(`
    DELETE FROM topic_viewpoints v USING comments c
    WHERE c.id = v."topicId" AND c."parentComment" IS NULL AND c."createdAt" = v."createdAt"
  `)
  await knex.raw('DELETE FROM topic_viewpoints WHERE data IS NULL')
  await knex.raw('ALTER TABLE topic_viewpoints ALTER COLUMN data SET NOT NULL')
  await knex.schema.alterTable('topic_viewpoints', (table) => {
    table.dropColumn('guid')
    table.dropColumn('index')
    table.dropColumn('bcf')
    table.dropColumn('snapshotType')
  })
  await knex.schema.alterTable('comment_document_references', (table) => {
    table.dropColumn('guid')
  })
  await knex.schema.alterTable('comments', (table) => {
    table.dropColumn('guid')
    table.dropColumn('creationAuthor')
    table.dropColumn('modifiedAuthor')
    table.dropColumn('modifiedDate')
    table.dropColumn('referenceLinks')
    table.dropColumn('bimSnippet')
    table.dropColumn('viewpointGuid')
  })
}
