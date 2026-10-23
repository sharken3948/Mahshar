import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { NextRequest } from 'next/server'
import { boundary, resetBoundary } from './register.mjs'
import { paidBoundary, resetPaid } from './paid-register.mjs'
import { alice, bob, reset, sessionHeaders, state, origin } from '../marketplace/fixtures'
import { encryptKey } from '../../src/lib/crypto'
import { POST as envelopeProxy } from '../../src/app/api/proxy/route'
import { GET as pathProxy } from '../../src/app/api/proxy/[api_id]/route'
import { GET as recover } from '../../src/app/api/calls/last-response/route'
import { PURCHASE_ACCESS_HEADER } from '../../src/lib/marketplace/purchase-access'
import type { AuthType } from '../../src/types'

const apiId = '11111111-1111-4111-8111-111111111111'
const seller = alice.address.toLowerCase(), buyer = bob.address.toLowerCase()
beforeEach(() => { reset(); resetBoundary(); resetPaid(); paidBoundary.payer = buyer })
function seed(type: AuthType, credential?: string) {
  const row = { id: apiId, name: 'Paid provider', seller_wallet: seller, price_per_call: 0.01, auth_type: type,
    encrypted_key: credential ? encryptKey(credential) : null, auth_param_name: type === 'queryparam' ? 'api_key' : null, method: 'GET',
    endpoint_url: 'https://provider.example/data', is_active: true, verified_at: new Date().toISOString(),
    dynamic_path_supported: false, path_parameters: [], query_parameters: [] }
  state.tables.api_listings.push(row)
  return row
}
function request(path: string, method: string, body?: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(origin + path, { method, headers: { origin, 'payment-signature': 'synthetic-no-money', ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
}
const models: Array<[AuthType, string | undefined, string, string]> = [
  ['public', undefined, 'content-type', 'application/json'],
  ['apikey', 'paid-legacy-key', 'x-api-key', 'paid-legacy-key'],
  ['bearer', 'paid-legacy-bearer', 'authorization', 'Bearer paid-legacy-bearer'],
  ['queryparam', 'paid-legacy-query', 'query:api_key', 'paid-legacy-query'],
  ['basic', '{"username":"token-id","password":"paid-basic-secret"}', 'authorization', `Basic ${Buffer.from('token-id:paid-basic-secret').toString('base64')}`],
  ['headers', '{"headers":[{"name":"X-Provider-Key","value":"paid-custom-secret"}]}', 'x-provider-key', 'paid-custom-secret'],
  ['authorization', '{"scheme":"Token","token":"paid-token-secret"}', 'authorization', 'Token paid-token-secret'],
  ['authorization', '{"scheme":"ApiKey","token":"paid-apikey-secret"}', 'authorization', 'ApiKey paid-apikey-secret'],
  ['headers', '{"headers":[{"name":"X-Provider-Key","value":"paid-multi-secret"},{"name":"Client.ID","value":"client-identity"}],"authorization":{"scheme":"Bearer","token":"paid-multi-bearer"}}', 'authorization', 'Bearer paid-multi-bearer'],
  ['headers', '{"headers":[{"name":"api_key","value":"paid-combined-secret"}],"authorization":{"scheme":"Basic","username":"paid-identifier","password":"paid-password"}}', 'authorization', `Basic ${Buffer.from('paid-identifier:paid-password').toString('base64')}`],
]
for (const [index, [type, credential, name, value]] of models.entries()) for (const entrance of ['envelope', 'path']) test(`paid ${index} ${type}/${entrance}: actual proxy, durable delivery, replay and capability-only recovery`, async () => {
  seed(type, credential)
  const input = { api_id: apiId, buyer_wallet: buyer }
  const execute = () => entrance === 'envelope' ? envelopeProxy(request('/api/proxy', 'POST', input))
    : pathProxy(request(`/api/proxy/${apiId}`, 'GET'), { params: Promise.resolve({ api_id: apiId }) })
  const response = await execute()
  assert.equal(response.status, 200, await response.clone().text())
  const body = await response.json()
  assert.equal(body.payment, 'ACCOUNTING_COMPLETE')
  assert.equal(body.delivery_state, 'SUCCEEDED')
  assert.deepEqual(body.response, { result: 'safe-result' })
  assert.equal(name.startsWith('query:') ? new URL(boundary.requests[0].url).searchParams.get('api_key') : boundary.requests[0].init.headers[name], value)
  if (credential?.includes('paid-multi-secret')) {
    assert.equal(boundary.requests[0].init.headers['x-provider-key'], 'paid-multi-secret')
    assert.equal(boundary.requests[0].init.headers['client.id'], 'client-identity')
  }
  assert.equal(state.settled, 1)
  assert.equal(boundary.requests.length, 1)
  const replay = await execute()
  assert.equal(replay.status, 200)
  assert.equal(state.settled, 1)
  assert.equal(boundary.requests.length, 1)
  const recovered = await recover(request(`/api/calls/last-response?api_id=${apiId}&buyer_wallet=${buyer}`, 'GET', undefined,
    { [PURCHASE_ACCESS_HEADER]: body.purchase_access_token }))
  assert.equal(recovered.status, 200)
  assert.deepEqual((await recovered.json()).response_body, { result: 'safe-result' })
  assert.ok(!JSON.stringify(state.tables.api_calls).includes(value))
})

