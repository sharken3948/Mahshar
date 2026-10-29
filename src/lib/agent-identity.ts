import 'server-only'
import {
  BaseError, ContractFunctionRevertedError, createPublicClient, http, keccak256,
  parseAbi, zeroAddress, type Address, type PublicClient,
} from 'viem'

export const IDENTITY_CHAIN_ID = 5042
export const IDENTITY_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' as const
const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
// Verified through the configured Arc RPC; upgrades require an explicit review.
const PROXY_CODE_HASH = '0xd0e45b1d89fa9b6cc7e97c1f155d64180e5c232aaccf9900ef9d4fd738c02b41'
const IMPLEMENTATION_CODE_HASH = '0xa5f9624ea85e45b3f4b8558581f03bfb3e6cefab278d7bf0500ec9bd065dc16f'
const UINT256_MAX = (BigInt(1) << BigInt(256)) - BigInt(1)
const abi = parseAbi([
  'function supportsInterface(bytes4 interfaceId) view returns (bool)',
  'function getVersion() view returns (string)',
  'function ownerOf(uint256 agentId) view returns (address)',
  'function getAgentWallet(uint256 agentId) view returns (address)',
  'error ERC721NonexistentToken(uint256 tokenId)',
])

export class AgentIdentityError extends Error {
  constructor(public readonly code: 'invalid_identity_query' | 'agent_not_found' | 'identity_unavailable',
    public readonly status: 400 | 404 | 503) { super(code) }
}

export interface IdentityQuery { agentId: bigint; wallet?: Address }

/** The tuple is mandatory: an agent ID is never globally unique by itself. */
export function parseIdentityQuery(params: URLSearchParams): IdentityQuery {
  const allowed = new Set(['chain_id', 'registry', 'agent_id', 'wallet'])
  const invalid = () => new AgentIdentityError('invalid_identity_query', 400)
  for (const key of params.keys()) {
    if (!allowed.has(key) || params.getAll(key).length !== 1) throw invalid()
  }
  const id = params.get('agent_id')
  const wallet = params.get('wallet')
  if (params.get('chain_id') !== String(IDENTITY_CHAIN_ID)
    || params.get('registry')?.toLowerCase() !== IDENTITY_REGISTRY.toLowerCase()
    || id === null || !/^(0|[1-9][0-9]{0,77})$/.test(id)
    || BigInt(id) > UINT256_MAX
    || (wallet !== null && (!/^0x[0-9a-fA-F]{40}$/.test(wallet) || wallet.toLowerCase() === zeroAddress))) {
    throw invalid()
  }
  return { agentId: BigInt(id), ...(wallet === null ? {} : { wallet: wallet.toLowerCase() as Address }) }
}

function configuredClient() {
  const rpc = process.env.ARC_MAINNET_RPC_URL
  if (!rpc) throw new AgentIdentityError('identity_unavailable', 503)
  const deadline = AbortSignal.timeout(12_000)
  // Never accept a caller-supplied RPC/URL, follow redirects, or fetch metadata.
  return createPublicClient({ transport: http(rpc, { timeout: 4_000, retryCount: 0,
    fetchOptions: { cache: 'no-store', redirect: 'error',
      headers: { 'User-Agent': 'Mahshar-ERC8004-reader/1' } },
    fetchFn: (input, init) => fetch(input, { ...init,
      signal: AbortSignal.any([deadline, ...(init?.signal ? [init.signal] : [])]) }),
  }) })
}

/** Public facts only. Neither the query wallet nor a matching relationship authenticates a caller. */
export async function readAgentIdentity(query: IdentityQuery, client?: PublicClient) {
  try {
    if (query.agentId < BigInt(0) || query.agentId > UINT256_MAX) {
      throw new AgentIdentityError('invalid_identity_query', 400)
    }
    const rpc = client ?? configuredClient()
    const [chainId, block] = await Promise.all([rpc.getChainId(), rpc.getBlock({ blockTag: 'latest' })])
    const now = BigInt(Math.floor(Date.now() / 1000))
    if (chainId !== IDENTITY_CHAIN_ID || block.number === null || !block.hash
      || now - block.timestamp > BigInt(120) || block.timestamp - now > BigInt(30)) throw new Error('Invalid chain snapshot')
    const at = { address: IDENTITY_REGISTRY, blockNumber: block.number } as const
    const [proxy, slot] = await Promise.all([
      rpc.getCode(at), rpc.getStorageAt({ ...at, slot: IMPLEMENTATION_SLOT }),
    ])
    if (!proxy || keccak256(proxy) !== PROXY_CODE_HASH || !slot || !/^0x0{24}[0-9a-fA-F]{40}$/.test(slot)) {
      throw new Error('Unrecognized registry')
    }
    const [implementation, erc165, erc721, invalidInterface, version] = await Promise.all([
      rpc.getCode({ address: `0x${slot.slice(-40)}`, blockNumber: block.number }),
      rpc.readContract({ ...at, abi, functionName: 'supportsInterface', args: ['0x01ffc9a7'] }),
      rpc.readContract({ ...at, abi, functionName: 'supportsInterface', args: ['0x80ac58cd'] }),
      rpc.readContract({ ...at, abi, functionName: 'supportsInterface', args: ['0xffffffff'] }),
      rpc.readContract({ ...at, abi, functionName: 'getVersion' }),
    ])
    if (!implementation || keccak256(implementation) !== IMPLEMENTATION_CODE_HASH
      || !erc165 || !erc721 || invalidInterface || version !== '2.0.0') throw new Error('Unsupported registry')
    let owner: Address
    try {
      owner = await rpc.readContract({ ...at, abi, functionName: 'ownerOf', args: [query.agentId] })
    } catch (error) {
      const revert = error instanceof BaseError
        ? error.walk(cause => cause instanceof ContractFunctionRevertedError) : undefined
      if (revert instanceof ContractFunctionRevertedError && revert.data?.errorName === 'ERC721NonexistentToken'
        && revert.data.args?.[0] === query.agentId) {
        const confirmed = await rpc.getBlock({ blockNumber: block.number })
        if (confirmed.hash === block.hash) throw new AgentIdentityError('agent_not_found', 404)
      }
      throw error
    }
    const agentWallet = await rpc.readContract({ ...at, abi, functionName: 'getAgentWallet', args: [query.agentId] })
    const confirmed = await rpc.getBlock({ blockNumber: block.number })
    if (owner === zeroAddress || confirmed.hash !== block.hash) throw new Error('Invalid identity snapshot')
    const normalizedOwner = owner.toLowerCase() as Address
    const normalizedAgentWallet = agentWallet === zeroAddress ? null : agentWallet.toLowerCase() as Address
    const wallet = query.wallet?.toLowerCase()
    return {
      schema_version: '1', verification: 'onchain_snapshot', chain_id: IDENTITY_CHAIN_ID,
      registry: IDENTITY_REGISTRY, agent_id: query.agentId.toString(),
      owner: normalizedOwner, agent_wallet: normalizedAgentWallet,
      wallet_relationship: wallet ? { wallet, is_owner: wallet === normalizedOwner,
        is_agent_wallet: wallet === normalizedAgentWallet } : null,
      requester_authenticated: false, binding_created: false,
      block: { number: block.number.toString(), hash: block.hash, timestamp: block.timestamp.toString() },
    }
  } catch (error) {
    if (error instanceof AgentIdentityError) throw error
    // RPC errors can contain credentials, request URLs and provider internals.
    throw new AgentIdentityError('identity_unavailable', 503)
  }
}
