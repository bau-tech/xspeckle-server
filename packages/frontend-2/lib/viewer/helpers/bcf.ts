/**
 * BCF topic property vocabularies, the same as the external BCF server's
 * defaults, so values created here stay interoperable with it.
 * `stage` has no entry -- that server ships no default vocabulary for it either
 * (it's an open, per-project free-text field there too).
 */
export const BCF_TOPIC_TYPES = ['Issue', 'Clash', 'Request', 'Remark']
export const BCF_TOPIC_STATUSES = ['Open', 'In Progress', 'Closed']
export const BCF_PRIORITIES = ['Low', 'Normal', 'High', 'Critical']

/**
 * A native <input type="date"> gives/expects a bare "YYYY-MM-DD" string, but
 * the dueDate field is a GraphQL DateTime scalar, which requires a full
 * ISO-8601 datetime -- sending the bare date string fails scalar validation
 * for the whole mutation (not just that field), so this must be converted
 * only at the point of sending, not stored in the ref used to back the
 * input itself (which needs to stay as the bare date for the native input
 * to display it correctly on round-trip).
 */
export function toBcfDueDateInput(date: string | null): string | null {
  if (!date) return null
  return new Date(`${date}T00:00:00.000Z`).toISOString()
}

/**
 * The inverse of toBcfDueDateInput, for populating a native date input from
 * a stored ISO DateTime value (e.g. an existing topic's dueDate).
 */
export function fromBcfDueDate(dueDate: string | null | undefined): string | null {
  if (!dueDate) return null
  const parsed = new Date(dueDate)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toISOString().slice(0, 10)
}
