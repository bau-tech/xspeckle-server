import { toValue, type MaybeRefOrGetter } from 'vue'
import { useAuthCookie } from '~~/lib/auth/composables/auth'

/**
 * Connections of a project's models to external BCF API 3.0 / 2.1 servers -- see
 * the server's modules/bcfsync/rest/connections.ts.
 */

export type BcfSyncDirection = 'two-way' | 'pull' | 'push'
export type BcfConnectionStatus = 'pending' | 'authorized' | 'active' | 'error' | 'disabled'

export type BcfConnection = {
  id: string
  projectId: string
  modelId: string
  name: string
  serverUrl: string
  remoteProjectId: string | null
  remoteProjectName: string | null
  direction: BcfSyncDirection
  status: BcfConnectionStatus
  lastError: string | null
  lastSyncAt: string | null
  lastSyncResult: {
    at: string
    counts: Record<string, number>
    conflicts: number
    skipped: number
    applied: number
    failed: Array<{ kind: string; action: string; guid: string; error: string }>
    warnings?: string[]
  } | null
  createdAt: string
}

export type BcfSyncOperation = {
  kind: 'topic' | 'comment' | 'viewpoint'
  action: string
  guid: string
  topicGuid: string | null
  title: string
  conflict?: boolean
  restore?: boolean
}

export type BcfSyncReport = {
  dryRun: boolean
  counts: Record<string, number>
  conflicts: number
  skipped: Array<{ guid: string; title: string; reason: string }>
  operations: BcfSyncOperation[]
  applied?: number
  failed?: Array<{ kind: string; action: string; guid: string; error: string }>
  /** Values the BCF server does not allow, and what was sent instead. */
  warnings?: string[]
}

/** A BCF server as server admins manage it (the secret is never sent back). */
export type BcfServer = {
  id: string
  name: string
  url: string
  clientId: string | null
  hasClientSecret: boolean
  createdAt: string
  updatedAt: string
}

/** A BCF server to offer when connecting (no secrets). */
export type BcfServerChoice = {
  name: string
  url: string
  /** Set up by the server admin (else: used before in this project). */
  configured: boolean
  /** The admin registered an OAuth client for it. */
  hasClient: boolean
}

export const bcfDirectionLabels: Record<BcfSyncDirection, string> = {
  'two-way': 'Two-way',
  pull: 'Only from the BCF server',
  push: 'Only to the BCF server'
}

/** "topic create-local" -> "Topics created here" etc. */
export const bcfOperationLabel = (key: string) => {
  const [kind, action] = key.split(' ')
  const what = { topic: 'Topics', comment: 'Comments', viewpoint: 'Viewpoints' }[kind] || kind
  const how =
    {
      'create-local': 'created here',
      'create-remote': 'created on the BCF server',
      'update-local': 'updated here',
      'update-remote': 'updated on the BCF server',
      'delete-local': 'deleted here',
      'delete-remote': 'deleted on the BCF server'
    }[action] || action
  return `${what} ${how}`
}

const useBcfSyncApi = () => {
  const apiOrigin = useApiOrigin()
  const authToken = useAuthCookie()

  return async <T>(
    method: string,
    path: string,
    body?: Record<string, unknown>
  ): Promise<T> => {
    const res = await fetch(`${apiOrigin}/api/v1/bcf-sync${path}`, {
      method,
      headers: {
        ...(authToken.value ? { Authorization: `Bearer ${authToken.value}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    })
    if (res.status === 204) return undefined as T
    let json: unknown = null
    try {
      json = await res.json()
    } catch {
      // handled below
    }
    if (!res.ok) {
      const message = (json as { error?: string } | null)?.error || res.statusText
      throw new Error(message)
    }
    return json as T
  }
}

/** Server settings: the BCF servers offered when connecting (admins only). */
export function useBcfServerAdmin() {
  const call = useBcfSyncApi()
  return {
    list: () => call<BcfServer[]>('GET', '/servers'),
    create: (input: { name: string; url: string; clientId?: string; clientSecret?: string }) =>
      call<BcfServer>('POST', '/servers', input),
    /** clientSecret: omitted keeps it, '' removes it. */
    update: (
      id: string,
      input: { name?: string; url?: string; clientId?: string; clientSecret?: string }
    ) => call<BcfServer>('PATCH', `/servers/${id}`, input),
    remove: (id: string) => call<void>('DELETE', `/servers/${id}`)
  }
}

export function useBcfServerConnections(projectId: MaybeRefOrGetter<string>) {
  const call = useBcfSyncApi()
  const project = () => encodeURIComponent(toValue(projectId))

  return {
    listConnections: () => call<BcfConnection[]>('GET', `/projects/${project()}/connections`),
    listModels: () =>
      call<Array<{ id: string; name: string }>>('GET', `/projects/${project()}/models`),
    listServers: () =>
      call<{ servers: BcfServerChoice[]; callbackUrl: string }>(
        'GET',
        `/projects/${project()}/servers`
      ),
    startConnection: (input: {
      modelId: string
      serverUrl: string
      name?: string
      direction: BcfSyncDirection
      clientId?: string
      clientSecret?: string
      returnTo?: string
    }) =>
      call<{ connection: BcfConnection; authorizeUrl: string }>(
        'POST',
        `/projects/${project()}/connections`,
        input
      ),
    listRemoteProjects: (connectionId: string) =>
      call<Array<{ id: string; name: string }>>(
        'GET',
        `/connections/${connectionId}/remote-projects`
      ),
    selectRemoteProject: (
      connectionId: string,
      input: { remoteProjectId: string; direction?: BcfSyncDirection }
    ) => call<BcfConnection>('POST', `/connections/${connectionId}/remote-project`, input),
    sync: (connectionId: string, opts: { dryRun: boolean; allowMassDelete?: boolean }) =>
      call<BcfSyncReport>(
        'POST',
        `/connections/${connectionId}/sync?${new URLSearchParams({
          dryRun: String(opts.dryRun),
          ...(opts.allowMassDelete ? { allowMassDelete: 'true' } : {})
        })}`
      ),
    reauthorize: (connectionId: string, returnTo?: string) =>
      call<{ authorizeUrl: string }>('POST', `/connections/${connectionId}/reauthorize`, {
        returnTo
      }),
    activate: (connectionId: string) =>
      call<BcfConnection>('POST', `/connections/${connectionId}/activate`),
    disable: (connectionId: string) =>
      call<BcfConnection>('POST', `/connections/${connectionId}/disable`),
    remove: (connectionId: string) => call<void>('DELETE', `/connections/${connectionId}`)
  }
}
