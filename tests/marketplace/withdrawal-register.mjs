import Module from 'node:module'
import { createRequire } from 'node:module'

const load = Module._load
const viem = createRequire(import.meta.url)('viem')

export const withdrawalState = globalThis.__mahsharWithdrawalState ??= {
  transferMode: 'success', transferCalls: 0, statusCalls: 0, mintCalls: 0,
  gasPriceFails: false, receiptStatus: 'success', transferId: null,
}
export function resetWithdrawalState() {
  withdrawalState.transferMode = 'success'; withdrawalState.transferCalls = 0
  withdrawalState.statusCalls = 0; withdrawalState.mintCalls = 0
  withdrawalState.gasPriceFails = false; withdrawalState.receiptStatus = 'success'
  withdrawalState.transferId = null
}

const attestation = `0x${'ab'.repeat(32)}`
const attestationSignature = `0x${'cd'.repeat(65)}`
globalThis.fetch = async input => {
  const url = String(input)
  if (url.endsWith('/balances')) return Response.json({ balances: [{ balance: '100.000000' }] })
  if (url.includes('/transfer/')) {
    withdrawalState.statusCalls++
    if (withdrawalState.transferMode === 'status-failed') return Response.json({ status: 'failed', forwardingDetails: { failureReason: 'validation rejected' } })
    if (withdrawalState.transferMode === 'status-pending') return Response.json({ status: 'pending' })
    return Response.json({ status: 'confirmed', attestation: { payload: attestation, signature: attestationSignature, expirationBlock: '999' } })
  }
  if (url.endsWith('/transfer')) {
    withdrawalState.transferCalls++
    if (withdrawalState.transferMode === 'timeout') throw new DOMException('timed out', 'TimeoutError')
    if (withdrawalState.transferMode === '500') return Response.json({ success: false, message: 'internal error' }, { status: 500 })
    if (withdrawalState.transferMode === 'malformed') return new Response('{"attestation":', { status: 200 })
    if (withdrawalState.transferMode === 'malformed-with-id') return Response.json({ transferId: 'transfer-fixture', attestation: 'truncated' })
    if (withdrawalState.transferMode === 'success-false') return Response.json({ success: false, message: 'uncertain execution' })
    if (withdrawalState.transferMode === 'rejected') return Response.json({ success: false, message: 'invalid burn intent' }, { status: 400 })
    return Response.json({ attestation, signature: attestationSignature, transferId: 'transfer-fixture' })
  }
  throw new Error(`Unexpected withdrawal fetch: ${url}`)
}

Module._load = function (id, parent, main) {
  if (id === 'viem') return {
    ...viem,
    createPublicClient: () => ({
      verifyMessage: async ({ address, message, signature }) => {
        try {
          const recovered = await viem.recoverMessageAddress({ message, signature })
          return recovered.toLowerCase() === address.toLowerCase()
        } catch {
          return false
        }
      },
      estimateContractGas: async () => 140000n,
      getGasPrice: async () => {
        if (withdrawalState.gasPriceFails) throw new Error('rpc unavailable')
        return 1_000_000_000n
      },
      waitForTransactionReceipt: async () => ({ status: withdrawalState.receiptStatus }),
    }),
    createWalletClient: () => ({ writeContract: async () => {
      withdrawalState.mintCalls++
      return `0x${withdrawalState.mintCalls.toString(16).padStart(64, '0')}`
    } }),
  }
  return load.call(this, id, parent, main)
}
