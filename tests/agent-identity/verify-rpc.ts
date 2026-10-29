// Explicit, read-only live check. Supply ARC_MAINNET_RPC_URL; never loads .env files.
import { createPublicClient, http, keccak256, parseAbi } from 'viem'
import { IDENTITY_REGISTRY, parseIdentityQuery, readAgentIdentity } from '../../src/lib/agent-identity'

async function main() {
  if (!process.env.ARC_MAINNET_RPC_URL) throw new Error('Configured RPC required')
  const identity = await readAgentIdentity(parseIdentityQuery(new URLSearchParams({
    chain_id: '5042', registry: IDENTITY_REGISTRY, agent_id: process.argv[2] ?? '0',
  })))
  const client = createPublicClient({ transport: http(process.env.ARC_MAINNET_RPC_URL,
    { timeout: 10_000, retryCount: 0, fetchOptions: { redirect: 'error', cache: 'no-store',
      headers: { 'User-Agent': 'Mahshar-ERC8004-reader/1' } } }) })
  const blockNumber = BigInt(identity.block.number)
  const reputation = '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63'
  const abi = parseAbi(['function getIdentityRegistry() view returns (address)',
    'function getVersion() view returns (string)', 'function getClients(uint256) view returns (address[])'])
  const evidence = []
  for (const address of [IDENTITY_REGISTRY, reputation] as const) {
    const code = await client.getCode({ address, blockNumber })
    const slot = await client.getStorageAt({ address, blockNumber,
      slot: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' })
    if (!code || !slot) throw new Error('Registry deployment unavailable')
    const implementation = `0x${slot.slice(-40)}` as const
    const implementationCode = await client.getCode({ address: implementation, blockNumber })
    if (!implementationCode) throw new Error('Implementation unavailable')
    evidence.push({ registry: address, code_bytes: (code.length - 2) / 2, code_hash: keccak256(code),
      implementation, implementation_bytes: (implementationCode.length - 2) / 2,
      implementation_hash: keccak256(implementationCode),
      version: await client.readContract({ address, abi, functionName: 'getVersion', blockNumber }) })
  }
  const linkedRegistry = await client.readContract({ address: reputation, abi,
    functionName: 'getIdentityRegistry', blockNumber })
  if (linkedRegistry.toLowerCase() !== IDENTITY_REGISTRY.toLowerCase()) throw new Error('Reputation registry mismatch')
  const clients = await client.readContract({ address: reputation, abi, functionName: 'getClients',
    args: [BigInt(identity.agent_id)], blockNumber })
  console.log(JSON.stringify({ identity, registries: evidence,
    reputation_identity_registry: linkedRegistry, reputation_client_count: clients.length }, null, 2))
}

main().catch(() => {
  console.error('Read-only registry verification failed; endpoint and provider details withheld.')
  process.exitCode = 1
})
