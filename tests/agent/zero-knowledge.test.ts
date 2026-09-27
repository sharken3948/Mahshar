import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MahsharPublicAgent, MemoryCapabilityStore, type AgentSigner, type PublicAgentListing } from '../../scripts/mahshar-agent-client.mjs'

const wallet = `0x${'11'.repeat(20)}` as `0x${string}`
const payTo = `0x${'22'.repeat(20)}`
const asset = '0x3600000000000000000000000000000000000000'
const verifyingContract = '0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE'
const signer: AgentSigner = { address: wallet, signTypedData: async () => `0x${'ab'.repeat(65)}` }

function listing(id: string, method: PublicAgentListing['method'], style: PublicAgentListing['proxy_style'], dynamic = false): PublicAgentListing {
  return {
    id, name: `${method} fixture`, price_per_call_usdc: 0.001, method,
    proxy_url: style === 'path' ? `https://mahshar.test/api/proxy/${id}` : 'https://mahshar.test/api/proxy',
    proxy_style: style,
    request: {
      outer_method: style === 'path' ? method : 'POST',
      body: { supported: method !== 'GET', required: false, example: method === 'GET' ? null : { fixture: true } },
      dynamic_path: { supported: dynamic, transport: dynamic ? 'envelope.path' : null },
      query_parameters: dynamic ? [{ name: 'mode', enum: ['server-error'] }] : [],
    },
  }
}

test('zero-knowledge client discovers, pays GET and envelope, persists access, and fences replay/failure', async () => {
  const listings = [listing('get-id', 'GET', 'path'), listing('put-id', 'PUT', 'envelope', true)]
  const paid = new Map<string, { attemptId: string; transaction: string; failure: boolean }>()
  let settlements = 0
  const capabilities = new Set<string>()

  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
    if (url.pathname === '/api/agent/discover') return Response.json({
      openapi_url: '/api/openapi', apis: listings, payment_recipient: payTo,
      payment_domain: { name: 'GatewayWalletBatched', version: '1', verifyingContract },
    })
    if (url.pathname === '/api/openapi') return new Response('openapi: 3.1.0\ninfo:\n  title: fixture\n')
    if (url.pathname === '/api/calls/last-response') {
      const capability = new Headers(init?.headers).get('x-mahshar-purchase-access')
      return capabilities.has(capability ?? '') ? Response.json({ response_body: { fixture: true } }) : Response.json({ error: 'forbidden' }, { status: 403 })
    }

    const headers = new Headers(init?.headers)
    const paymentSignature = headers.get('payment-signature')
    if (!paymentSignature) {
      const requirement = { x402Version: 2, resource: { url: url.pathname }, accepts: [{ scheme: 'exact', network: 'eip155:5042',
        asset, amount: '1100', payTo, maxTimeoutSeconds: 345600,
        extra: { name: 'GatewayWalletBatched', version: '1', verifyingContract } }] }
      return Response.json({}, { status: 402, headers: { 'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(requirement)).toString('base64') } })
    }

    const envelope = init?.body ? JSON.parse(String(init.body)) as { path?: string; api_id?: string } : {}
    const failure = envelope.path === '?mode=server-error'
    let record = paid.get(paymentSignature)
    if (!record) {
      settlements++
      record = { attemptId: `00000000-0000-4000-8000-${String(settlements).padStart(12, '0')}`, transaction: `tx-${settlements}`, failure }
      paid.set(paymentSignature, record)
      const capability = `capability-${settlements}`; capabilities.add(capability)
      return Response.json({ response: failure ? { error: 'controlled' } : { fixture: true }, payment: 'ACCOUNTING_COMPLETE',
        delivery_state: failure ? 'FAILED_FINAL' : 'SUCCEEDED', attemptId: record.attemptId, purchase_access_token: capability }, {
        status: failure ? 500 : 200,
        headers: { 'PAYMENT-RESPONSE': Buffer.from(JSON.stringify({ success: true, payer: wallet, network: 'eip155:5042', transaction: record.transaction })).toString('base64') },
      })
    }
    return Response.json({ ...(record.failure ? { error: 'delivery_failed_final' } : { payment: 'ACCOUNTING_COMPLETE' }),
      delivery_state: record.failure ? 'FAILED_FINAL' : 'SUCCEEDED', attemptId: record.attemptId, purchase_access_token: 'replay-capability' }, {
      status: record.failure ? 409 : 200,
      headers: { 'PAYMENT-RESPONSE': Buffer.from(JSON.stringify({ success: true, payer: wallet, network: 'eip155:5042', transaction: record.transaction })).toString('base64') },
    })
  }

  const agent = new MahsharPublicAgent('https://mahshar.test/', signer, new MemoryCapabilityStore(), fetcher, 0.001)
  const discovered = await agent.discover()
  const getExecution = await agent.execute(agent.select(discovered.listings, 'path'))
  assert.deepEqual(await agent.retrieve(listings[0]), { response_body: { fixture: true } })
  assert.equal((await agent.replay(getExecution)).data.delivery_state, 'SUCCEEDED')

  const putExecution = await agent.execute(agent.select(discovered.listings, 'envelope'))
  assert.equal(putExecution.data.delivery_state, 'SUCCEEDED')
  const failure = await agent.execute(agent.selectControlledFailure(discovered.listings), { path: '?mode=server-error' })
  assert.equal(failure.response.status, 500)
  const replay = await agent.replay(failure)
  assert.equal(replay.response.status, 409)
  assert.equal(replay.data.error, 'delivery_failed_final')
  assert.equal(settlements, 3, 'each authorization settles once; replays never settle again')
})

test('zero-knowledge client aborts before signing above the configured price ceiling', async () => {
  let signatures = 0
  const guardedSigner: AgentSigner = { address: wallet, signTypedData: async () => { signatures++; return `0x${'ab'.repeat(65)}` } }
  const expensive = listing('expensive', 'GET', 'path'); expensive.price_per_call_usdc = 0.01
  const agent = new MahsharPublicAgent('https://mahshar.test/', guardedSigner, new MemoryCapabilityStore(), fetch, 0.001)
  await assert.rejects(agent.execute(expensive), /ceiling/)
  assert.equal(signatures, 0)
})
