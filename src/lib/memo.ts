import {
  createWalletClient,
  http,
  keccak256,
  toHex,
  encodeAbiParameters,
  parseAbiParameters,
  encodeFunctionData,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arcTestnet } from '@/lib/chains'
import { PLATFORM_PRIVATE_KEY } from '@/lib/gateway'

const MEMO_CONTRACT = '0x5294E9927c3306DcBaDb03fe70b92e01cCede505' as `0x${string}`
const ARC_USDC = '0x3600000000000000000000000000000000000000' as `0x${string}`

const MEMO_ABI = [
  {
    type: 'function',
    name: 'memo',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'target', type: 'address' },
      { name: 'data', type: 'bytes' },
      { name: 'memoId', type: 'bytes32' },
      { name: 'memoData', type: 'bytes' },
    ],
    outputs: [],
  },
] as const

const ERC20_ABI = [
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const

export async function writeMemo(
  apiName: string,
  sellerWallet: string,
  callId: string,
): Promise<void> {
  const account = privateKeyToAccount(PLATFORM_PRIVATE_KEY)
  const walletClient = createWalletClient({
    account,
    chain: arcTestnet,
    transport: http(),
  })

  const memoId = keccak256(toHex(callId))

  const memoData = encodeAbiParameters(
    parseAbiParameters('string, address, string'),
    [apiName, sellerWallet as `0x${string}`, callId],
  )

  // Inner call: transfer(platformWallet, 0) on USDC.
  // approve(address(0), 0) would revert — Circle's FiatToken rejects zero-address spender.
  // transfer(self, 0) is safe: no zero-address check on recipient, 0 <= balance always passes.
  const subcallData = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: 'transfer',
    args: [account.address, BigInt(0)],
  })

  const txHash = await walletClient.writeContract({
    address: MEMO_CONTRACT,
    abi: MEMO_ABI,
    functionName: 'memo',
    args: [ARC_USDC, subcallData, memoId, memoData],
  })

  console.log(`[memo] api=${apiName} call_id=${callId} tx=${txHash}`)
}
