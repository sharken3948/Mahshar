import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildUpstreamAuthentication } from './upstream-auth'

test('upstream authentication supports only public, API key, bearer and query-parameter modes', () => {
  const base = new URL('https://seller.example/check?fixed=keep')
  const credential = 'synthetic-secret'

  const publicAuth = buildUpstreamAuthentication(base, 'public', credential)
  assert.equal(publicAuth.requestUrl.toString(), base.toString())
  assert.deepEqual(publicAuth.headers, { 'content-type': 'application/json' })

  const apiKey = buildUpstreamAuthentication(base, 'apikey', credential)
  assert.equal(apiKey.headers['x-api-key'], credential)
  assert.equal(apiKey.headers.authorization, undefined)

  const bearer = buildUpstreamAuthentication(base, 'bearer', credential)
  assert.equal(bearer.headers.authorization, `Bearer ${credential}`)
  assert.equal(bearer.headers['x-api-key'], undefined)

  const query = buildUpstreamAuthentication(base, 'queryparam', credential, 'api_key')
  assert.equal(query.requestUrl.searchParams.get('fixed'), 'keep')
  assert.equal(query.requestUrl.searchParams.get('api_key'), credential)
  assert.deepEqual(query.headers, { 'content-type': 'application/json' })
})
