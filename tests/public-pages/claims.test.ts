import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (path: string) => readFileSync(path, 'utf8')

test('Agents page claims are backed by the public machine contract and examples', () => {
  const discovery = read('src/app/api/agent/discover/route.ts')
  const contract = read('src/lib/marketplace/agent-contract.ts')
  const openapi = read('openapi.yaml')
  const guide = read('docs/agent-integration.md')
  const client = read('scripts/mahshar-agent-client.mts')
  const harness = read('scripts/mahshar-agent-e2e.mts')
  const retrieval = read('src/app/api/calls/last-response/route.ts')
  const agents = read('src/app/agents/page.tsx')

  assert.match(discovery, /\.eq\('is_active', true\)/)
  for (const field of ['price_per_call_usdc', 'proxy_url', 'proxy_style', 'request:', 'response:']) assert.ok(discovery.includes(field), field)
  assert.match(contract, /proxy_style: entry\.proxy_style/)
  assert.match(openapi, /openapi: 3\.1\.0/)
  assert.match(openapi, /network: \{ const: 'eip155:5042' \}/)
  assert.match(openapi, /purchase_access_token/)
  assert.match(guide, /`FAILED_RETRYABLE` means Mahshar proved no upstream dispatch occurred/)
  assert.match(guide, /does not settle again, refund, or execute upstream/)
  assert.match(client, /class MahsharPublicAgent/)
  assert.match(client, /async retrieve\(/)
  assert.match(client, /async replay\(/)
  assert.match(harness, /DRY RUN:.*no payment was signed or sent/)
  assert.match(retrieval, /\.eq\('api_id', apiId\)/)
  assert.match(retrieval, /\.eq\('buyer_wallet', buyerWallet\.toLowerCase\(\)\)/)
  assert.match(agents, /latest successful private response for that API and buyer wallet/)
  assert.doesNotMatch(agents, /latest successful private response for that purchase/)
})

test('Docs provider, auth, payment, and wallet statements match current implementations', () => {
  const onboarding = read('src/components/OnboardingForm.tsx')
  const buyer = read('src/app/buyer/page.tsx')
  const contract = read('src/lib/marketplace/agent-contract.ts')
  const journey = read('src/app/dashboard/wallet/bridge/useBridgeJourney.ts')
  const solana = read('src/app/dashboard/solana/page.tsx')

  for (const field of ['endpoint_url', 'method', 'auth_type', 'price_per_call', 'example_request', 'example_response']) assert.ok(onboarding.includes(field), field)
  assert.match(onboarding, /Continue to AI Review/)
  assert.match(buyer, /probeRes = await fetch\('\/api\/proxy'/)
  assert.match(buyer, /Payment-Signature/)
  assert.match(contract, /Buyer-supplied headers are not forwarded upstream/)
  assert.match(journey, /switchEvmChainAsync\(\{ chainId: Arc\.chainId \}\)/)
  assert.match(journey, /evmConnector\.getProvider\(\)/)
  assert.match(journey, /UnifiedBalanceChain\.Arc/)
  assert.match(solana, /The recipient is fixed to your connected EVM wallet/)
  assert.match(solana, /This is a separate transaction/)
})

test('Support exposes only the support channel already used by Mahshar', () => {
  const support = read('src/app/support/page.tsx')
  const settings = read('src/app/dashboard/settings/page.tsx')
  assert.match(settings, /mailto:support@mahshar\.xyz/)
  assert.match(support, /mailto:support@mahshar\.xyz/)
  assert.doesNotMatch(support, /live chat|ticket portal|response time|SLA|status page|community/i)
})
