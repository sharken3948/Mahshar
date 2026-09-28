import type { BridgeResult, EstimateResult } from '@circle-fin/bridge-kit'
import { parseUnits } from 'viem'

export const SMALL_BRIDGE_AMOUNT = 'Amount is too small for the current Circle bridge fee. Increase the amount and try again.'

// A completed burn or later Circle stage is evidence that USDC may have moved.
// Approval alone is not a burn, and an errored simulation has no source transfer.
export function fundsMayHaveMoved(result: BridgeResult): boolean {
  return result.steps.some(step => {
    const name = step.name.toLowerCase()
    if (name === 'burn') return step.state === 'success' || validSourceHash(step.txHash, result.source.chain.type)
    // The SDK only records executed steps. Reaching attestation or mint means
    // the source burn may already have happened even if its hash was omitted.
    return ['fetchattestation', 'mint'].includes(name)
  })
}

function validSourceHash(hash: string | undefined, type: string): boolean {
  if (!hash) return false
  return type === 'solana' ? /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(hash) : /^0x[a-fA-F0-9]{64}$/.test(hash)
}

export function resumableResult(result: BridgeResult): boolean {
  return result.state !== 'success' && (result.state === 'pending' || fundsMayHaveMoved(result))
}

export function preBroadcastFailure(error: unknown): boolean {
  const value = error instanceof Error ? error.message : String(error)
  return /MaxFeeMustBeLessThanAmount|simulation failed|transaction simulation|user rejected|user denied|rejected the request|wallet rejected/i.test(value)
}

export function bridgeErrorMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error)
  if (/ChainMismatchError|chainId mismatch|Active chainId is .*received/i.test(value)) return 'Your wallet network is still updating. Switch to Arc to continue.'
  if (/MaxFeeMustBeLessThanAmount/i.test(value)) return SMALL_BRIDGE_AMOUNT
  if (/user rejected|user denied|rejected the request|wallet rejected/i.test(value)) return 'The wallet declined the bridge transaction. No USDC was bridged.'
  if (/simulation failed|transaction simulation/i.test(value)) return 'The source transaction could not be simulated. No USDC was bridged.'
  return value.split('\n')[0] || 'Circle could not complete this bridge.'
}

// Circle's fee entries are the SDK's provider/forwarder max-fee estimate in USDC.
// Unknown fees are not guessed; execution rechecks the estimate before wallet actions.
export function circleFeeIssue(amount: string, estimate: EstimateResult | null): string | null {
  if (!estimate) return null
  const fees = estimate.fees.filter(fee => fee.token === 'USDC')
  if (!fees.length || fees.some(fee => fee.amount === null || fee.error)) return null
  try {
    const maxFee = fees.reduce((sum, fee) => sum + parseUnits(fee.amount!, 6), BigInt(0))
    return maxFee >= parseUnits(amount, 6) ? SMALL_BRIDGE_AMOUNT : null
  } catch { return null }
}
