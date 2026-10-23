import { useAuthCookie } from '~~/lib/auth/composables/auth'
import {
  useInjectedViewerLoadedResources,
  useInjectedViewerState
} from '~~/lib/viewer/composables/setup'

/** A BCF server's value lists for a project (BCF 3.0 project extensions). */
export type BcfServerValueLists = Partial<
  Record<'topic_type' | 'topic_status' | 'topic_label' | 'priority' | 'stage' | 'users', string[]>
>

/**
 * The value lists of the BCF servers the loaded models sync with -- users a
 * topic can be assigned to, types, statuses, priorities -- merged; empty
 * without such a connection. Read once per page and set of models (see the
 * server's GET /api/v1/bcf-sync/projects/:id/extensions).
 */
export function useBcfServerValueLists() {
  const isEnabled = useIsBcfSyncEnabled()
  const apiOrigin = useApiOrigin()
  const authToken = useAuthCookie()
  const { projectId } = useInjectedViewerState()
  const { modelsAndVersionIds } = useInjectedViewerLoadedResources()
  const cache = useState<Record<string, BcfServerValueLists>>(
    'bcf-server-value-lists',
    () => ({})
  )

  const modelIds = computed(() =>
    [...new Set(modelsAndVersionIds.value.map((m) => m.model.id))].sort().join(',')
  )
  const key = computed(() => `${projectId.value}/${modelIds.value}`)

  const load = async (project: string, models: string, cacheKey: string) => {
    if (!isEnabled.value || !authToken.value || !project || !models) return
    if (cacheKey in cache.value) return
    cache.value = { ...cache.value, [cacheKey]: {} }
    try {
      const res = await fetch(
        `${apiOrigin}/api/v1/bcf-sync/projects/${encodeURIComponent(
          project
        )}/extensions?${new URLSearchParams({ modelIds: models })}`,
        { headers: { Authorization: `Bearer ${authToken.value}` } }
      )
      if (res.ok) cache.value = { ...cache.value, [cacheKey]: await res.json() }
    } catch {
      // no lists: the built-in choices are used
    }
  }

  if (import.meta.client)
    watch(key, (k) => void load(projectId.value, modelIds.value, k), { immediate: true })

  return computed(() => cache.value[key.value] || {})
}

/**
 * A select's choices: the BCF server's list when it has one, else the
 * built-in defaults -- plus the current value if it is in neither.
 */
export const bcfChoices = (
  serverList: string[] | undefined,
  defaults: string[],
  current?: string | null
) => {
  const base = serverList?.length ? serverList : defaults
  return current && !base.includes(current) ? [...base, current] : base
}
