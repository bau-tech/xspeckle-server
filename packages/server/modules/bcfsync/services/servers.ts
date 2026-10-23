/**
 * The BCF servers offered when connecting a model, managed by server admins
 * (server settings -> BCF servers). Users can still connect to any other BCF
 * server by its address.
 */
import { discoverBcfServer, normaliseBaseUrl } from '@/modules/bcfsync/clients/bcf/discovery'
import type { BcfServerRecord } from '@/modules/bcfsync/repositories/servers'
import { BadRequestError } from '@/modules/shared/errors'

/** What admins see of a server: never the client secret. */
export interface BcfServerPublic {
  id: string
  name: string
  url: string
  clientId: string | null
  hasClientSecret: boolean
  createdAt: Date
  updatedAt: Date
}

export const toPublicServer = (s: BcfServerRecord): BcfServerPublic => ({
  id: s.id,
  name: s.name,
  url: s.url,
  clientId: s.clientId,
  hasClientSecret: !!s.clientSecretEnc,
  createdAt: s.createdAt,
  updatedAt: s.updatedAt
})

/** What project owners see when connecting: no client details. */
export interface BcfServerChoice {
  name: string
  url: string
  /** Set up by a server admin (else: used before in this project). */
  configured: boolean
  /** The admin registered an OAuth client for it. */
  hasClient: boolean
}

export const bcfServerChoices = (
  configured: Array<Pick<BcfServerRecord, 'name' | 'url' | 'clientId'>>,
  usedInProject: Array<{ name: string; baseUrl: string }>
): BcfServerChoice[] => {
  const choices: BcfServerChoice[] = configured.map((s) => ({
    name: s.name,
    url: s.url,
    configured: true,
    hasClient: !!s.clientId
  }))
  for (const u of usedInProject) {
    if (choices.some((c) => c.url === u.baseUrl)) continue
    choices.push({ name: u.name, url: u.baseUrl, configured: false, hasClient: false })
  }
  return choices
}

export interface BcfServerInput {
  name?: unknown
  url?: unknown
  clientId?: unknown
  /** Omitted: unchanged; '' or null: removed. */
  clientSecret?: unknown
}

/**
 * Checks an admin's input: the address must be a BCF API 3.0 server with
 * OAuth2 sign-in, and without automatic client registration it needs a
 * registered client. Returns the normalised URL.
 */
export const validateBcfServerInputFactory =
  (deps: { fetchFn?: typeof fetch } = {}) =>
  async (input: { url: string; clientId: string | null }) => {
    let url: string
    try {
      url = normaliseBaseUrl(input.url)
    } catch (e) {
      throw new BadRequestError((e as Error).message)
    }
    let info
    try {
      info = await discoverBcfServer(url, deps.fetchFn)
    } catch (e) {
      throw new BadRequestError(`Not usable as a BCF server: ${(e as Error).message}`)
    }
    if (!info.registrationUrl && !input.clientId)
      throw new BadRequestError(
        'This server does not register clients automatically: enter the client id (and secret) of an OAuth client registered there'
      )
    return { url: info.baseUrl, automaticRegistration: !!info.registrationUrl }
  }
