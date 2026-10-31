import 'server-only'
import { createPublicClient, hashMessage, http, verifyMessage, type Address, type Hex } from 'viem'
import { arcMainnet } from '@/lib/chains'

const ERC1271_ABI = [{
  type: 'function', name: 'isValidSignature', stateMutability: 'view',
  inputs: [{ name: 'hash', type: 'bytes32' }, { name: 'signature', type: 'bytes' }],
  outputs: [{ name: 'magicValue', type: 'bytes4' }],
}] as const

/** Verify the seller address itself on Arc; never substitute a contract's owner EOA. */
export async function verifyWithdrawalMessage(input: { address: Address; message: string; signature: Hex }): Promise<boolean> {
  try {
    const client = createPublicClient({ chain: arcMainnet,
      transport: http(process.env.ARC_MAINNET_RPC_URL, { timeout: 10_000, retryCount: 0 }) })
    if (await client.getChainId() !== arcMainnet.id) return false

    const code = await client.getCode({ address: input.address })
    if (!code || code === '0x') return await verifyMessage(input)

    // Call ERC-1271 directly: a contract rejection/error must not fall back to
    // EOA recovery (including for an address with delegated account code).
    const result = await client.readContract({
      address: input.address, abi: ERC1271_ABI, functionName: 'isValidSignature',
      args: [hashMessage(input.message), input.signature],
    })
    return result === '0x1626ba7e'
  } catch {
    return false
  }
}
