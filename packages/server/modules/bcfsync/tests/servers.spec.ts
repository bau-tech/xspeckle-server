import { expect } from 'chai'
import {
  bcfServerChoices,
  toPublicServer,
  validateBcfServerInputFactory
} from '@/modules/bcfsync/services/servers'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })

/** A BCF 3.0 server at https://bcf.test, with or without RFC 7591 registration. */
const fakeBcf = (registration: boolean) =>
  (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url === 'https://bcf.test/bcf/versions')
      return json({
        versions: [{ api_id: 'bcf', version_id: '3.0', api_base_url: 'https://bcf.test/bcf/3.0/' }]
      })
    if (url === 'https://bcf.test/bcf/3.0/auth')
      return json({
        oauth2_auth_url: 'https://bcf.test/authorize',
        oauth2_token_url: 'https://bcf.test/token',
        ...(registration ? { oauth2_dynamic_client_reg_url: 'https://bcf.test/register' } : {})
      })
    return json({}, 404)
  }) as typeof fetch

const rejects = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (e) {
    return (e as Error).message
  }
  throw new Error('expected a rejection')
}

describe('BCF sync servers', () => {
  it('offers configured servers first, then ones used in the project', () => {
    expect(
      bcfServerChoices(
        [{ name: 'P', url: 'https://p.example.com', clientId: 'id' }],
        [
          { name: 'p again', baseUrl: 'https://p.example.com' },
          { name: 'Other', baseUrl: 'https://o.example.com' }
        ]
      )
    ).to.deep.equal([
      { name: 'P', url: 'https://p.example.com', configured: true, hasClient: true },
      { name: 'Other', url: 'https://o.example.com', configured: false, hasClient: false }
    ])
  })

  it('never shows the client secret', () => {
    const now = new Date()
    const shown = toPublicServer({
      id: '1',
      name: 'P',
      url: 'https://p',
      clientId: 'id',
      clientSecretEnc: 'v1.secret',
      createdAt: now,
      updatedAt: now
    })
    expect(shown).to.include({ hasClientSecret: true, clientId: 'id' })
    expect(JSON.stringify(shown)).to.not.include('v1.secret')
  })

  it('accepts a BCF 3.0 server and normalises its address', async () => {
    const validate = validateBcfServerInputFactory({ fetchFn: fakeBcf(true) })
    expect(await validate({ url: ' https://bcf.test/ ', clientId: null })).to.deep.equal({
      url: 'https://bcf.test',
      automaticRegistration: true
    })
  })

  it('needs a client id when the server cannot register clients', async () => {
    const validate = validateBcfServerInputFactory({ fetchFn: fakeBcf(false) })
    expect(await rejects(validate({ url: 'https://bcf.test', clientId: null }))).to.include(
      'client id'
    )
    expect(await validate({ url: 'https://bcf.test', clientId: 'abc' })).to.deep.include({
      automaticRegistration: false
    })
  })

  it('rejects what is not a BCF server', async () => {
    const validate = validateBcfServerInputFactory({ fetchFn: fakeBcf(true) })
    expect(await rejects(validate({ url: 'https://elsewhere.test', clientId: null }))).to.include(
      'Not usable as a BCF server'
    )
    expect(await rejects(validate({ url: 'ftp://x', clientId: null }))).to.include('https://')
  })
})
