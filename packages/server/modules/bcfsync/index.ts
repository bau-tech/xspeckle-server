import type { SpeckleModule } from '@/modules/shared/helpers/typeHelper'
import { moduleLogger } from '@/observability/logging'
import { db } from '@/db/knex'
import { getFeatureFlags } from '@/modules/shared/helpers/envHelper'
import { scheduleExecutionFactory } from '@/modules/core/services/taskScheduler'
import {
  acquireTaskLockFactory,
  releaseTaskLockFactory
} from '@/modules/core/repositories/scheduledTasks'
import type { ScheduleExecution } from '@/modules/core/domain/scheduledTasks/operations'
import { getBcfSyncRouter } from '@/modules/bcfsync/rest/connections'
import { getBcfServersRouter } from '@/modules/bcfsync/rest/servers'
import { scheduleBcfSync } from '@/modules/bcfsync/services/cron'

const { FF_BCF_SYNC_ENABLED } = getFeatureFlags()

let scheduledTask: ReturnType<ScheduleExecution> | null = null

/**
 * Sync of a model's BCF topics with any external BCF API 3.0 server.
 * Connections (discovery, OAuth sign-in, remote project choice) and a
 * scheduled two-way sync of active connections.
 */
const bcfSyncModule: SpeckleModule = {
  init: async ({ app, isInitial }) => {
    if (!FF_BCF_SYNC_ENABLED) return
    moduleLogger.info('🔁 Init BCF sync module')
    if (isInitial) {
      app.use(getBcfServersRouter())
      app.use(getBcfSyncRouter())
      scheduledTask = scheduleBcfSync({
        scheduleExecution: scheduleExecutionFactory({
          acquireTaskLock: acquireTaskLockFactory({ db }),
          releaseTaskLock: releaseTaskLockFactory({ db })
        })
      })
    }
  },
  shutdown: () => {
    scheduledTask?.stop()
  },
  finalize: () => {}
}

export default bcfSyncModule
