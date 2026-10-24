import type { SideTopic, TopicState } from '@/modules/bcfsync/domain/sync'

/**
 * The value lists a BCF server allows (its project `extensions`), by field.
 * A field without a list (or an empty one) accepts anything.
 */
export type BcfExtensionLists = Partial<
  Record<'topic_type' | 'topic_status' | 'topic_label' | 'priority' | 'stage' | 'users', string[]>
>

const EXTENSION_KEYS = [
  'topic_type',
  'topic_status',
  'topic_label',
  'priority',
  'stage',
  'users'
] as const

/**
 * Several connections' lists as one (a model can sync with more than one
 * BCF project): every value once, in first-seen order.
 */
export const mergeExtensionLists = (
  lists: Array<BcfExtensionLists | null | undefined>
): BcfExtensionLists => {
  const out: BcfExtensionLists = {}
  for (const key of EXTENSION_KEYS) {
    const values = [...new Set(lists.flatMap((l) => l?.[key] || []))]
    if (values.length) out[key] = values
  }
  return out
}

export const extensionLists = (extensions: Record<string, unknown>): BcfExtensionLists => {
  const out: BcfExtensionLists = {}
  for (const key of ['topic_type', 'topic_status', 'topic_label', 'priority', 'stage', 'users'] as const) {
    // BCF 2.1 calls the user list `user_id_type`.
    const v = key === 'users' && !extensions.users ? extensions.user_id_type : extensions[key]
    if (Array.isArray(v)) {
      const values = v.filter((x): x is string => typeof x === 'string' && x !== '')
      if (values.length) out[key] = values
    }
  }
  return out
}

/**
 * Fits a topic to the server's value lists. A value differing only in case
 * takes the server's spelling. Otherwise: on an update the server's current
 * value is kept, on a create the field is left empty; labels not allowed are
 * dropped. Each change is reported -- it is not an error, and as neither side
 * changed afterwards it does not cause another sync.
 */
export const fitToExtensions = (
  t: SideTopic,
  lists: BcfExtensionLists,
  current: SideTopic | undefined,
  warn: (message: string) => void
): TopicState => {
  const pick = (
    field: keyof BcfExtensionLists,
    label: string,
    value: string | null,
    fallback: string | null
  ) => {
    const allowed = lists[field]
    if (!value || !allowed) return value
    const match = allowed.find((a) => a.toLowerCase() === value.toLowerCase())
    if (match) return match
    warn(
      `"${t.state.title}": ${label} "${value}" is not allowed on the BCF server` +
        (fallback ? `; kept "${fallback}"` : '; left empty')
    )
    return fallback
  }
  const labels = lists.topic_label
    ? t.state.labels.flatMap((l) => {
        const match = lists.topic_label!.find((a) => a.toLowerCase() === l.toLowerCase())
        if (!match) warn(`"${t.state.title}": label "${l}" is not allowed on the BCF server; not sent`)
        return match ? [match] : []
      })
    : t.state.labels
  return {
    ...t.state,
    topicType: pick('topic_type', 'type', t.state.topicType, current?.state.topicType ?? null),
    topicStatus: pick('topic_status', 'status', t.state.topicStatus, current?.state.topicStatus ?? null),
    priority: pick('priority', 'priority', t.state.priority, current?.state.priority ?? null),
    stage: pick('stage', 'stage', t.state.stage, current?.state.stage ?? null),
    assignedTo: pick('users', 'assignee', t.state.assignedTo, current?.state.assignedTo ?? null),
    labels
  }
}
