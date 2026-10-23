import type { ScheduleExecution } from '@/modules/core/domain/scheduledTasks/operations'
import { db } from '@/db/knex'
import { getActiveBcfConnectionsFactory } from '@/modules/bcfsync/repositories/connections'
import { runBcfSync } from '@/modules/bcfsync/services/runner'
import { ensureError, TIME_MS } from '@speckle/shared'

/**
 * Syncs every active connection every 5 minutes. A run reads the whole remote
 * project (a comment added to a topic does not change the topic's
 * modified_date, so a date filter would miss it), hence not more often.
 */
export const scheduleBcfSync = (deps: { scheduleExecution: ScheduleExecution }) =>
  deps.scheduleExecution(
    '*/5 * * * *',
    'BcfServerSync',
    async (_now, { logger }) => {
      const connections = await getActiveBcfConnectionsFactory({ db })()
      for (const c of connections) {
        try {
          const report = await runBcfSync(c.id, { dryRun: false })
          if (report.applied || report.failed?.length)
            logger.info(
              {
                connectionId: c.id,
                projectId: c.projectId,
                counts: report.counts,
                applied: report.applied,
                failed: report.failed?.length,
                conflicts: report.conflicts
              },
              'BCF sync {connectionId}: {applied} applied, {failed} failed'
            )
        } catch (e) {
          logger.warn(
            { err: ensureError(e), connectionId: c.id, projectId: c.projectId },
            'BCF sync {connectionId} failed'
          )
        }
      }
    },
    20 * TIME_MS.minute
  )
