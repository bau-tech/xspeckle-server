import { BcfServerError } from '@/modules/bcfsync/clients/bcf/discovery'

export interface BcfRemoteProject {
  project_id: string
  name: string
  authorization?: { project_actions?: string[] }
}

export interface BcfRemoteUser {
  id: string
  name?: string
}

/** Wire shapes as the BCF API 3.0 / 2.1 serves them; every field may be missing. */
export type BcfWireTopic = Record<string, unknown> & { guid: string }
export type BcfWireComment = Record<string, unknown> & { guid: string }
export type BcfWireViewpoint = Record<string, unknown> & { guid: string }

export interface BcfClientOptions {
  /** BCF API root with trailing slash. */
  apiBaseUrl: string
  /** Current access token; called again after a 401 with `forceRefresh`. */
  getAccessToken: (forceRefresh: boolean) => Promise<string>
  fetchFn?: typeof fetch
  /** Max wait honoured for a 429 Retry-After, in ms. */
  maxRetryWaitMs?: number
}

const REQUEST_TIMEOUT_MS = 30_000
const TOPIC_PAGE = 100

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const withGuid = <T>(rows: unknown): Array<T & { guid: string }> =>
  Array.isArray(rows)
    ? rows.filter(
        (r): r is T & { guid: string } =>
          !!r && typeof r === 'object' && typeof (r as { guid?: unknown }).guid === 'string'
      )
    : []

type Query = Record<string, string | number | undefined>

/**
 * Thin BCF API 3.0 / 2.1 client: auth header, one token refresh on 401, one wait on
 * 429, and OData paging helpers. It returns the raw wire shapes (snake_case);
 * mapping them to Speckle topics happens in the sync services.
 */
export class BcfClient {
  private readonly fetchFn: typeof fetch

  constructor(private readonly opts: BcfClientOptions) {
    this.fetchFn = opts.fetchFn || fetch
  }

  private url(path: string, query?: Query) {
    const u = new URL(path.replace(/^\//, ''), this.opts.apiBaseUrl)
    for (const [k, v] of Object.entries(query || {}))
      if (v !== undefined && v !== '') u.searchParams.set(k, String(v))
    return u.toString()
  }

  private async send(
    method: string,
    path: string,
    args: {
      query?: Query
      body?: unknown
      headers?: Record<string, string>
      allow?: number[]
      accept?: string
    }
  ): Promise<Response> {
    const once = async (forceRefresh: boolean) => {
      const token = await this.opts.getAccessToken(forceRefresh)
      return await this.fetchFn(this.url(path, args.query), {
        method,
        headers: {
          Accept: args.accept || 'application/json',
          Authorization: `Bearer ${token}`,
          ...(args.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(args.headers || {})
        },
        body: args.body !== undefined ? JSON.stringify(args.body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
    }

    let res = await once(false)
    if (res.status === 401) res = await once(true)
    if (res.status === 429) {
      const wait = Math.min(
        (Number(res.headers.get('retry-after')) || 2) * 1000,
        this.opts.maxRetryWaitMs ?? 30_000
      )
      await sleep(wait)
      res = await once(false)
    }
    if (!res.ok && !args.allow?.includes(res.status)) {
      let detail = ''
      try {
        detail = (await res.text()).slice(0, 300)
      } catch {
        // ignore
      }
      throw new BcfServerError(
        `${method} ${path} failed with HTTP ${res.status}${detail ? `: ${detail}` : ''}`,
        res.status
      )
    }
    return res
  }

  async request(
    method: string,
    path: string,
    args: {
      query?: Query
      body?: unknown
      headers?: Record<string, string>
      /** Treat these statuses as a result, not an error. */
      allow?: number[]
    } = {}
  ): Promise<{ status: number; headers: Headers; json: unknown }> {
    const res = await this.send(method, path, args)
    let json: unknown = null
    if (res.status !== 204) {
      try {
        json = await res.json()
      } catch {
        json = null
      }
    }
    return { status: res.status, headers: res.headers, json }
  }

  private project(projectId: string) {
    return `projects/${encodeURIComponent(projectId)}`
  }

  private topic(projectId: string, topicGuid: string) {
    return `${this.project(projectId)}/topics/${encodeURIComponent(topicGuid)}`
  }

  async currentUser(): Promise<BcfRemoteUser> {
    return (await this.request('GET', 'current-user')).json as BcfRemoteUser
  }

  async listProjects(): Promise<BcfRemoteProject[]> {
    const { json } = await this.request('GET', 'projects')
    return Array.isArray(json) ? (json as BcfRemoteProject[]) : []
  }

  async getProject(projectId: string): Promise<BcfRemoteProject> {
    return (await this.request('GET', this.project(projectId))).json as BcfRemoteProject
  }

  async getExtensions(projectId: string): Promise<Record<string, unknown>> {
    const { json } = await this.request('GET', `${this.project(projectId)}/extensions`)
    return (json as Record<string, unknown>) || {}
  }

  /**
   * One page of topics. `filter` is a BCF/OData expression, e.g.
   * `modified_date ge 2026-10-01T00:00:00Z`.
   */
  async listTopics(
    projectId: string,
    args: { filter?: string; orderby?: string; top?: number; skip?: number } = {}
  ): Promise<BcfWireTopic[]> {
    const { json } = await this.request('GET', `${this.project(projectId)}/topics`, {
      query: {
        $filter: args.filter,
        $orderby: args.orderby,
        $top: args.top,
        $skip: args.skip
      }
    })
    return withGuid(json)
  }

  /**
   * Every topic, paged. A server that ignores $top/$skip returns everything
   * in the first page; that is detected (a repeated guid) and stops paging.
   */
  async listAllTopics(projectId: string, args: { filter?: string } = {}) {
    const byGuid = new Map<string, BcfWireTopic>()
    for (let skip = 0; ; skip += TOPIC_PAGE) {
      const page = await this.listTopics(projectId, {
        ...args,
        orderby: 'creation_date',
        top: TOPIC_PAGE,
        skip
      })
      let fresh = 0
      for (const t of page) {
        if (byGuid.has(t.guid)) continue
        byGuid.set(t.guid, t)
        fresh++
      }
      if (page.length < TOPIC_PAGE || fresh === 0) break
    }
    return [...byGuid.values()]
  }

  async listComments(projectId: string, topicGuid: string): Promise<BcfWireComment[]> {
    const { json } = await this.request('GET', `${this.topic(projectId, topicGuid)}/comments`)
    return withGuid(json)
  }

  async listViewpoints(projectId: string, topicGuid: string): Promise<BcfWireViewpoint[]> {
    const { json } = await this.request('GET', `${this.topic(projectId, topicGuid)}/viewpoints`)
    return withGuid(json)
  }

  /**
   * A viewpoint's components. BCF 3.0 and 2.1 serve them as sub-resources, not in
   * the viewpoint itself; a missing one (404) counts as empty.
   */
  async getViewpointComponents(projectId: string, topicGuid: string, viewpointGuid: string) {
    const base = `${this.topic(projectId, topicGuid)}/viewpoints/${encodeURIComponent(
      viewpointGuid
    )}`
    const get = async (part: string) => {
      const { status, json } = await this.request('GET', `${base}/${part}`, { allow: [404] })
      return status === 404 ? null : (json as Record<string, unknown> | null)
    }
    const [selection, coloring, visibility] = await Promise.all([
      get('selection'),
      get('coloring'),
      get('visibility')
    ])
    return {
      selection: selection?.selection,
      coloring: coloring?.coloring,
      visibility: visibility?.visibility
    }
  }

  /** The snapshot image, or null when the viewpoint has none. */
  async getSnapshot(
    projectId: string,
    topicGuid: string,
    viewpointGuid: string
  ): Promise<{ type: 'png' | 'jpg'; data: Uint8Array } | null> {
    const res = await this.send(
      'GET',
      `${this.topic(projectId, topicGuid)}/viewpoints/${encodeURIComponent(
        viewpointGuid
      )}/snapshot`,
      { allow: [404], accept: 'image/png, image/jpeg' }
    )
    if (res.status === 404) return null
    const data = new Uint8Array(await res.arrayBuffer())
    if (!data.length) return null
    const contentType = res.headers.get('content-type') || ''
    return { type: /jpe?g/i.test(contentType) ? 'jpg' : 'png', data }
  }

  async listRelatedTopicGuids(projectId: string, topicGuid: string): Promise<string[]> {
    const { status, json } = await this.request(
      'GET',
      `${this.topic(projectId, topicGuid)}/related_topics`,
      { allow: [404] }
    )
    if (status === 404 || !Array.isArray(json)) return []
    return json
      .map((r) => (r as { related_topic_guid?: unknown }).related_topic_guid)
      .filter((g): g is string => typeof g === 'string')
  }

  // --- writes ------------------------------------------------------------------

  async createTopic(projectId: string, body: Record<string, unknown>): Promise<BcfWireTopic> {
    const { json } = await this.request('POST', `${this.project(projectId)}/topics`, { body })
    return json as BcfWireTopic
  }

  async updateTopic(
    projectId: string,
    topicGuid: string,
    body: Record<string, unknown>
  ): Promise<BcfWireTopic> {
    const { json } = await this.request('PUT', this.topic(projectId, topicGuid), { body })
    return json as BcfWireTopic
  }

  /** True when it was deleted, false when it was already gone. */
  async deleteTopic(projectId: string, topicGuid: string): Promise<boolean> {
    const { status } = await this.request('DELETE', this.topic(projectId, topicGuid), {
      allow: [404]
    })
    return status !== 404
  }

  async createComment(
    projectId: string,
    topicGuid: string,
    body: Record<string, unknown>
  ): Promise<BcfWireComment> {
    const { json } = await this.request('POST', `${this.topic(projectId, topicGuid)}/comments`, {
      body
    })
    return json as BcfWireComment
  }

  async updateComment(
    projectId: string,
    topicGuid: string,
    commentGuid: string,
    body: Record<string, unknown>
  ): Promise<BcfWireComment> {
    const { json } = await this.request(
      'PUT',
      `${this.topic(projectId, topicGuid)}/comments/${encodeURIComponent(commentGuid)}`,
      { body }
    )
    return json as BcfWireComment
  }

  async deleteComment(projectId: string, topicGuid: string, commentGuid: string) {
    const { status } = await this.request(
      'DELETE',
      `${this.topic(projectId, topicGuid)}/comments/${encodeURIComponent(commentGuid)}`,
      { allow: [404] }
    )
    return status !== 404
  }

  async createViewpoint(
    projectId: string,
    topicGuid: string,
    body: Record<string, unknown>
  ): Promise<BcfWireViewpoint> {
    const { json } = await this.request(
      'POST',
      `${this.topic(projectId, topicGuid)}/viewpoints`,
      { body }
    )
    return json as BcfWireViewpoint
  }

  async deleteViewpoint(projectId: string, topicGuid: string, viewpointGuid: string) {
    const { status } = await this.request(
      'DELETE',
      `${this.topic(projectId, topicGuid)}/viewpoints/${encodeURIComponent(viewpointGuid)}`,
      { allow: [404] }
    )
    return status !== 404
  }

  /** Replaces the whole collection (BCF 3.0 and 2.1). */
  async putRelatedTopics(projectId: string, topicGuid: string, guids: string[]) {
    await this.request('PUT', `${this.topic(projectId, topicGuid)}/related_topics`, {
      body: guids.map((g) => ({ related_topic_guid: g }))
    })
  }

  async addDocumentReference(
    projectId: string,
    topicGuid: string,
    body: Record<string, unknown>
  ) {
    await this.request('POST', `${this.topic(projectId, topicGuid)}/document_references`, {
      body
    })
  }

  async listDocumentReferences(
    projectId: string,
    topicGuid: string
  ): Promise<Array<Record<string, unknown>>> {
    const { status, json } = await this.request(
      'GET',
      `${this.topic(projectId, topicGuid)}/document_references`,
      { allow: [404] }
    )
    return status === 404 || !Array.isArray(json) ? [] : json
  }
}
