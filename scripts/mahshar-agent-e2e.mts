import { chmod, readFile, writeFile } from 'node:fs/promises'
import { privateKeyToAccount } from 'viem/accounts'
import { MahsharPublicAgent, type AgentSigner, type CapabilityStore } from './mahshar-agent-client.mjs'

class JsonCapabilityStore implements CapabilityStore {
  constructor(private readonly path: string) {}
  private async all(): Promise<Record<string, string>> {
    try { return JSON.parse(await readFile(this.path, 'utf8')) as Record<string, string> } catch { return {} }
  }
  private key(wallet: string, apiId: string) { return `${wallet.toLowerCase()}:${apiId}` }
  async get(wallet: string, apiId: string) { return (await this.all())[this.key(wallet, apiId)] ?? null }
  async set(wallet: string, apiId: string, capability: string) {
    const values = await this.all(); values[this.key(wallet, apiId)] = capability
    await writeFile(this.path, JSON.stringify(values, null, 2), { mode: 0o600 }); await chmod(this.path, 0o600)
  }
}

function liveSigner(): AgentSigner {
  const privateKey = process.env.MAHSHAR_AGENT_E2E_PRIVATE_KEY
  if (!privateKey || !/^0x[\da-f]{64}$/i.test(privateKey)) throw new Error('MAHSHAR_AGENT_E2E_PRIVATE_KEY is required for live mode')
  const account = privateKeyToAccount(privateKey as `0x${string}`)
  return { address: account.address, signTypedData: input => account.signTypedData(input) }
}

async function main() {
  const live = process.env.MAHSHAR_AGENT_E2E_LIVE === 'true'
  const baseUrl = process.env.MAHSHAR_BASE_URL ?? 'http://localhost:3000'
  const maxPrice = Number(process.env.MAHSHAR_AGENT_E2E_MAX_LISTING_USDC ?? '0.001')
  if (!Number.isFinite(maxPrice) || maxPrice <= 0 || maxPrice > 0.001) throw new Error('Live-test listing ceiling must be between 0 and 0.001 USDC')
  if (live && new URL(baseUrl).protocol !== 'https:') throw new Error('Live mode requires an HTTPS Mahshar base URL')

  if (!live) {
    const response = await fetch(new URL('/api/agent/discover', baseUrl))
    if (!response.ok) throw new Error(`Discovery failed (${response.status})`)
    const catalog = await response.json() as { openapi_url?: string; apis?: unknown[] }
    if (!catalog.openapi_url || !Array.isArray(catalog.apis)) throw new Error('Incomplete public discovery contract')
    const openapi = await fetch(new URL(catalog.openapi_url, baseUrl))
    if (!openapi.ok) throw new Error(`OpenAPI failed (${openapi.status})`)
    console.log(`DRY RUN: discovered ${catalog.apis.length} listings and OpenAPI; no payment was signed or sent.`)
    return
  }

  const agent = new MahsharPublicAgent(
    baseUrl,
    liveSigner(),
    new JsonCapabilityStore(process.env.MAHSHAR_AGENT_E2E_CAPABILITY_FILE ?? '.mahshar-agent-capabilities.json'),
    fetch,
    maxPrice,
  )
  const { listings } = await agent.discover()
  const selected = [agent.select(listings, 'path'), agent.select(listings, 'envelope')]
  for (const listing of selected) {
    const execution = await agent.execute(listing)
    await agent.retrieve(listing)
    await agent.replay(execution)
    console.log(`PASS: ${listing.method} ${listing.name} settled, delivered, capability-read, and replay-checked.`)
  }
  const failureListing = agent.selectControlledFailure(listings)
  const failure = await agent.execute(failureListing, { path: '?mode=server-error' })
  if (failure.response.status !== 500 || failure.data.delivery_state !== 'FAILED_FINAL') {
    throw new Error('Controlled upstream failure did not produce FAILED_FINAL')
  }
  const failureReplay = await agent.replay(failure)
  if (failureReplay.response.status !== 409 || failureReplay.data.error !== 'delivery_failed_final') {
    throw new Error('Controlled failure replay was not safely fenced')
  }
  console.log(`PASS: ${failureListing.name} controlled failure and no-resettlement replay contract.`)
}

await main()
