import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { proxyRequest } from '../../src/lib/proxy'
import { alice, reset, state } from './fixtures'
import { proxyState, resetProxyState } from './proxy-diagnostic-register.mjs'

beforeEach(() => {
  reset()
  resetProxyState()
  state.tables.api_listings.push({
    id: 'ioscope',
    name: 'Ioscope Wallet Risk Scoring',
    endpoint_url: 'https://www.ioscope.xyz/api/analyze',
    method: 'POST',
    is_active: true,
    auth_type: 'public',
    encrypted_key: null,
    verified_at: '2026-09-26T00:00:00.000Z',
  })
})

test('Ioscope 404 preserves the exact outbound URL and a bounded raw upstream diagnostic', async () => {
  const rawBody = '<html><body>upstream route not found</body></html>'
  proxyState.response = new Response(rawBody, {
    status: 404,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })

  const result = await proxyRequest({
    apiId: 'ioscope',
    buyerWallet: alice.address,
    paymentType: 'pay-per-call',
    method: 'POST',
    path: '',
    incomingHeaders: {},
    body: { address: alice.address, chain: 'arc' },
  })

  assert.equal(proxyState.targetUrl, 'https://www.ioscope.xyz/api/analyze')
  assert.equal(proxyState.outboundUrl, 'https://www.ioscope.xyz/api/analyze')
  assert.equal(result.status, 404)
  assert.equal(result.body, rawBody)
  assert.deepEqual(state.tables.api_calls[0].response_body, {
    upstream_status: 404,
    upstream_content_type: 'text/html; charset=utf-8',
    upstream_body: rawBody,
    upstream_body_truncated: false,
  })
})
