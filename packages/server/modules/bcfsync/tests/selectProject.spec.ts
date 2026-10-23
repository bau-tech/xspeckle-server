import { expect } from 'chai'
import { selectBcfRemoteProjectFactory } from '@/modules/bcfsync/services/connections'
import type { BcfServerConnectionRecord } from '@/modules/bcfsync/domain/types'
import type { BcfClient } from '@/modules/bcfsync/clients/bcf/client'

const connection = (over: Partial<BcfServerConnectionRecord>) =>
  ({
    id: 'new',
    projectId: 'p',
    modelId: 'm',
    baseUrl: 'https://bcf.test',
    clientId: 'client-new',
    clientSecretEnc: 'secret-new',
    accessTokenEnc: 'token-new',
    refreshTokenEnc: 'refresh-new',
    accessTokenExpiresAt: null,
    remoteProjectId: null,
    status: 'authorized',
    direction: 'two-way',
    lastError: null,
    ...over
  } as unknown as BcfServerConnectionRecord)

const setup = (existing?: BcfServerConnectionRecord) => {
  const rows = new Map<string, BcfServerConnectionRecord>()
  const deleted: string[] = []
  if (existing) rows.set(existing.id, existing)
  const select = selectBcfRemoteProjectFactory({
    updateConnection: async (id, update) => {
      const row = { ...(rows.get(id) || connection({ id })), ...update } as BcfServerConnectionRecord
      rows.set(id, row)
      return row
    },
    makeClient: async () =>
      ({ getProject: async (pid: string) => ({ project_id: pid, name: 'Remote' }) } as unknown as BcfClient),
    findConnectionForTarget: async (t) =>
      [...rows.values()].find(
        (r) => r.modelId === t.modelId && r.baseUrl === t.baseUrl && r.remoteProjectId === t.remoteProjectId
      ),
    deleteConnection: async (id) => {
      deleted.push(id)
      rows.delete(id)
    }
  })
  return { select, rows, deleted }
}

describe('BCF sync: choosing the BCF project', () => {
  it('sets it on a new connection, ready for a preview', async () => {
    const { select } = setup()
    const c = await select({ connection: connection({}), remoteProjectId: 'r1' })
    expect(c).to.deep.include({ id: 'new', remoteProjectId: 'r1', remoteProjectName: 'Remote', status: 'authorized' })
  })

  it('keeps the existing connection to the same project with the new sign-in', async () => {
    const existing = connection({
      id: 'old',
      remoteProjectId: 'r1',
      status: 'error',
      lastError: 'Sign-in expired',
      accessTokenEnc: 'token-old'
    })
    const { select, deleted } = setup(existing)
    const c = await select({ connection: connection({}), remoteProjectId: 'r1' })
    expect(c).to.deep.include({
      id: 'old',
      accessTokenEnc: 'token-new',
      clientId: 'client-new',
      status: 'active',
      lastError: null
    })
    expect(deleted).to.deep.equal(['new'])
  })
})
