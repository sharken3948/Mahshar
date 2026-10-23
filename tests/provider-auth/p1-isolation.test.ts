import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { NextRequest } from 'next/server'
import { reset, sessionHeaders, state } from '../marketplace/fixtures'
import { boundary, resetBoundary } from './register.mjs'
import { POST as create } from '../../src/app/api/apis/route'
import { POST as verify } from '../../src/app/api/apis/[id]/verify/route'
import { AUTH_BUNDLE_EXAMPLES } from '../../src/lib/marketplace/provider-auth-config'

beforeEach(() => { reset(); resetBoundary(); process.env.PROVIDER_OAUTH_PROFILES = '[]' })
test('P1 Create and Verify work with an empty P2 registry and never access OAuth storage', async () => {
  for (const auth_type of ['basic', 'headers', 'authorization'] as const) {
    const response = await create(new NextRequest('https://mahshar.xyz/api/apis', {
      method: 'POST', headers: sessionHeaders(), body: JSON.stringify({ name: 'P1', description: 'Synthetic', category: 'Data',
        price_per_call: 0.01, payment_model: 'pay-per-call', endpoint_url: 'https://provider.example/data', method: 'GET',
        auth_type, auth_key: AUTH_BUNDLE_EXAMPLES[auth_type] }),
    }))
    assert.equal(response.status, 201, await response.text())
    const row = state.tables.api_listings.at(-1)!
    const verified = await verify(new NextRequest(`https://mahshar.xyz/api/apis/${row.id}/verify`, {
      method: 'POST', headers: sessionHeaders(),
    }), { params: Promise.resolve({ id: row.id }) })
    assert.equal((await verified.json()).verified, true)
  }
  assert.equal(boundary.tokenCalls, 0)
  assert.deepEqual(boundary.rpcCalls, [])
  assert.deepEqual(state.tables.provider_oauth_accounts, [])
  assert.deepEqual(state.tables.provider_oauth_states, [])
})
