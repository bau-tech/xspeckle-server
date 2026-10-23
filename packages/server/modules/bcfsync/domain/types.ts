import type { BcfServerInfo } from '@/modules/bcfsync/clients/bcf/discovery'
import type { Nullable } from '@speckle/shared'

export type BcfSyncDirection = 'two-way' | 'pull' | 'push'
export type BcfConnectionStatus =
  | 'pending'
  | 'authorized'
  | 'active'
  | 'error'
  | 'disabled'

export interface BcfServerConnectionRecord {
  id: string
  projectId: string
  modelId: string
  createdBy: Nullable<string>
  name: string
  baseUrl: string
  server: BcfServerInfo
  clientId: string
  clientSecretEnc: Nullable<string>
  accessTokenEnc: Nullable<string>
  refreshTokenEnc: Nullable<string>
  accessTokenExpiresAt: Nullable<Date>
  oauthState: Nullable<string>
  oauthVerifier: Nullable<string>
  oauthStartedAt: Nullable<Date>
  /** Frontend path to return to after signing in. */
  oauthReturnTo: Nullable<string>
  remoteProjectId: Nullable<string>
  remoteProjectName: Nullable<string>
  direction: BcfSyncDirection
  status: BcfConnectionStatus
  lastError: Nullable<string>
  lastSyncAt: Nullable<Date>
  pullCursor: Nullable<Date>
  /** Summary of the last run (see runner.ts). */
  lastSyncResult: Nullable<Record<string, unknown>>
  createdAt: Date
  updatedAt: Date
}

/** What the API shows: never the secrets or the OAuth handshake state. */
export type BcfServerConnectionPublic = Omit<
  BcfServerConnectionRecord,
  | 'clientSecretEnc'
  | 'accessTokenEnc'
  | 'refreshTokenEnc'
  | 'oauthState'
  | 'oauthVerifier'
  | 'oauthReturnTo'
  | 'server'
> & { serverUrl: string }
