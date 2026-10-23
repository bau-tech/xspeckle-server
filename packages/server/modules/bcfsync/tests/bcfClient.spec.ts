import { expect } from 'chai'
import {
  BcfServerError,
  discoverBcfServer,
  normaliseBaseUrl
} from '@/modules/bcfsync/clients/bcf/discovery'
import {
  buildAuthorizeUrl,
  exchangeCode,
  generatePkce,
  refreshTokens,
  registerClient
} from '@/modules/bcfsync/clients/bcf/oauth'
import { BcfClient } from '@/modules/bcfsync/clients/bcf/client'
import { decryptSecret, encryptSecret } from '@/modules/bcfsync/services/secrets'
import crypto from 'node:crypto'

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  })

/** A fake BCF server answering by URL; records every request. */
const fakeServer = (routes: Record<string, (req: Request) => Response | Promise<Response>>) => {
  const calls: Request[] = []
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as string, init)
    calls.push(req)
    const url = new URL(req.url)
    const handler = routes[`${req.method} ${url.origin}${url.pathname}`]
    return handler ? handler(req) : json({ detail: 'nope' }, 404)
  }) as typeof fetch
  return { fetchFn, calls }
}

const base = 'https://bcf.test'
const discoveryRoutes = {
  [`GET ${base}/bcf/versions`]: () =>
    json({
      versions: [
        { api_id: 'bcf', version_id: '2.1', api_base_url: `${base}/bcf/2.1/` },
        { api_id: 'bcf', version_id: '3.0', api_base_url: `${base}/bcf/3.0` }
      ]
    }),
  [`GET ${base}/bcf/3.0/auth`]: () =>
    json({
      oauth2_auth_url: `${base}/oauth/authorize`,
      oauth2_token_url: `${base}/oauth/token`,
      oauth2_dynamic_client_reg_url: `${base}/oauth/register`,
      supported_oauth2_flows: ['authorization_code_grant']
    }),
  [`GET ${base}/.well-known/oauth-authorization-server`]: () =>
    json({
      token_endpoint_auth_methods_supported: ['client_secret_post'],
      scopes_supported: ['openid', 'bcf'],
      code_challenge_methods_supported: ['S256']
    })
}

describe('BCF sync client', () => {
  describe('normaliseBaseUrl', () => {
    it('strips trailing slashes, query and hash', () => {
      expect(normaliseBaseUrl(' https://bcf.test/x/?a=1#b ')).to.equal('https://bcf.test/x')
    })
    for (const bad of ['ftp://x', 'nope', 'https://u:p@bcf.test', 'http://169.254.169.254/'])
      it(`rejects ${bad}`, () => {
        expect(() => normaliseBaseUrl(bad)).to.throw(BcfServerError)
      })
  })

  describe('discoverBcfServer', () => {
    it('finds the BCF 3.0 API and the OAuth endpoints', async () => {
      const { fetchFn } = fakeServer(discoveryRoutes)
      const info = await discoverBcfServer(`${base}/`, fetchFn)
      expect(info).to.deep.include({
        baseUrl: base,
        apiBaseUrl: `${base}/bcf/3.0/`,
        authUrl: `${base}/oauth/authorize`,
        tokenUrl: `${base}/oauth/token`,
        registrationUrl: `${base}/oauth/register`,
        supportsPkce: true
      })
      expect(info.tokenAuthMethods).to.deep.equal(['client_secret_post'])
    })

    it('works without RFC 8414 metadata', async () => {
      const routes = { ...discoveryRoutes }
      delete routes[`GET ${base}/.well-known/oauth-authorization-server`]
      const info = await discoverBcfServer(base, fakeServer(routes).fetchFn)
      expect(info.registrationUrl).to.equal(`${base}/oauth/register`)
      expect(info.scopes).to.deep.equal([])
    })

    it('rejects a server without BCF 3.0', async () => {
      const { fetchFn } = fakeServer({
        [`GET ${base}/bcf/versions`]: () => json({ versions: [] })
      })
      let err: unknown
      try {
        await discoverBcfServer(base, fetchFn)
      } catch (e) {
        err = e
      }
      expect(err).to.be.instanceOf(BcfServerError)
    })
  })

  describe('OAuth', () => {
    it('builds an authorize URL with PKCE and only supported scopes', async () => {
      const info = await discoverBcfServer(base, fakeServer(discoveryRoutes).fetchFn)
      const { verifier, challenge } = generatePkce()
      expect(challenge).to.equal(
        crypto.createHash('sha256').update(verifier).digest('base64url')
      )
      const url = new URL(
        buildAuthorizeUrl({
          info,
          clientId: 'c1',
          redirectUri: 'https://x/cb',
          state: 's',
          codeChallenge: challenge
        })
      )
      expect(url.searchParams.get('code_challenge_method')).to.equal('S256')
      expect(url.searchParams.get('scope')).to.equal('openid bcf')
      expect(url.searchParams.get('state')).to.equal('s')
    })

    it('registers a client, exchanges a code and refreshes', async () => {
      const { fetchFn } = fakeServer({
        ...discoveryRoutes,
        [`POST ${base}/oauth/register`]: () =>
          json({ client_id: 'cid', client_secret: 'sec' }, 201),
        [`POST ${base}/oauth/token`]: async (req) => {
          const grant = new URLSearchParams(await req.text()).get('grant_type')
          return json({
            access_token: `at-${grant}`,
            expires_in: 3600,
            ...(grant === 'authorization_code' ? { refresh_token: 'rt1' } : {})
          })
        }
      })
      const info = await discoverBcfServer(base, fetchFn)
      const client = await registerClient({
        info,
        redirectUri: 'https://x/cb',
        clientName: 'xSpeckle',
        fetchFn
      })
      expect(client).to.deep.equal({ clientId: 'cid', clientSecret: 'sec' })

      // token requests carry the secret in the body (server only offers _post)
      const seen: string[] = []
      const capturing = (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith('/oauth/token')) seen.push(String(init?.body))
        return fetchFn(input, init)
      }) as typeof fetch
      const t = await exchangeCode({
        info,
        client,
        code: 'abc',
        codeVerifier: 'ver',
        redirectUri: 'https://x/cb',
        fetchFn: capturing
      })
      expect(t.accessToken).to.equal('at-authorization_code')
      expect(t.refreshToken).to.equal('rt1')
      expect(t.expiresAt!.getTime()).to.be.greaterThan(Date.now())
      expect(seen[0]).to.include('client_secret=sec').and.include('code_verifier=ver')

      const r = await refreshTokens({
        info,
        client,
        refreshToken: 'rt1',
        fetchFn: capturing
      })
      expect(r.accessToken).to.equal('at-refresh_token')
      // the server did not rotate it, so the old one is kept
      expect(r.refreshToken).to.equal('rt1')
    })
  })

  describe('BcfClient', () => {
    it('retries once with a refreshed token after a 401', async () => {
      const tokens: string[] = []
      let n = 0
      const { fetchFn } = fakeServer({
        [`GET ${base}/bcf/3.0/projects`]: (req) => {
          tokens.push(req.headers.get('authorization')!)
          return n++ === 0 ? json({}, 401) : json([{ project_id: 'p1', name: 'P' }])
        }
      })
      const client = new BcfClient({
        apiBaseUrl: `${base}/bcf/3.0/`,
        getAccessToken: async (force) => (force ? 'new' : 'old'),
        fetchFn
      })
      const projects = await client.listProjects()
      expect(projects).to.have.length(1)
      expect(tokens).to.deep.equal(['Bearer old', 'Bearer new'])
    })

    it('passes OData parameters and waits on 429', async () => {
      let n = 0
      const { fetchFn, calls } = fakeServer({
        [`GET ${base}/bcf/3.0/projects/p%201/topics`]: () =>
          n++ === 0 ? json({}, 429, { 'retry-after': '0' }) : json([{ guid: 'g' }])
      })
      const client = new BcfClient({
        apiBaseUrl: `${base}/bcf/3.0/`,
        getAccessToken: async () => 't',
        fetchFn,
        maxRetryWaitMs: 10
      })
      const topics = await client.listTopics('p 1', {
        filter: "modified_date ge 2026-10-01T00:00:00Z",
        top: 50
      })
      expect(topics).to.deep.equal([{ guid: 'g' }])
      const u = new URL(calls[1].url)
      expect(u.searchParams.get('$filter')).to.equal('modified_date ge 2026-10-01T00:00:00Z')
      expect(u.searchParams.get('$top')).to.equal('50')
    })

    it('reports HTTP errors with their status', async () => {
      const { fetchFn } = fakeServer({})
      const client = new BcfClient({
        apiBaseUrl: `${base}/bcf/3.0/`,
        getAccessToken: async () => 't',
        fetchFn
      })
      let err: BcfServerError | undefined
      try {
        await client.getProject('x')
      } catch (e) {
        err = e as BcfServerError
      }
      expect(err).to.be.instanceOf(BcfServerError)
      expect(err!.status).to.equal(404)
    })
  })

  describe('secrets', () => {
    it('round-trips and is bound to the key', () => {
      const enc = encryptSecret('hunter2', 'session-secret')
      expect(enc).to.match(/^v1\./).and.not.include('hunter2')
      expect(decryptSecret(enc, 'session-secret')).to.equal('hunter2')
      expect(() => decryptSecret(enc, 'other-secret')).to.throw()
      expect(encryptSecret('hunter2', 'session-secret')).to.not.equal(enc)
    })
  })
})
