import type { BridgeResult, EstimateResult } from '@circle-fin/bridge-kit'
type BridgeStep = BridgeResult['steps'][number]
import { Arc } from '@circle-fin/bridge-kit'

// Presentation of existing snapshots only; no RPCs, adapters or execution here.
export interface BalanceRow { key: string; name: string; balance: string; loading: boolean; disconnected?: boolean }
export function units(value: string): bigint | null {
  if (!/^\d+(\.\d{1,6})?$/.test(value)) return null
  const [whole, fraction = ''] = value.split('.')
  return BigInt(whole) * BigInt(1_000_000) + BigInt(fraction.padEnd(6, '0'))
}
export function displayUnits(value: bigint): string {
  const text = value.toString().padStart(7, '0')
  return `${text.slice(0, -6)}.${text.slice(-6).replace(/0+$/, '').padEnd(4, '0')}`
}
export function balanceValue(row: BalanceRow): bigint | null {
  return row.loading || row.disconnected ? null : units(row.balance)
}
export function distribution(rows: BalanceRow[]) {
  const funded = rows.map(row => ({ name: row.name, value: balanceValue(row) ?? BigInt(0) }))
    .filter(row => row.value > BigInt(0)).sort((a,b) => a.value > b.value ? -1 : a.value < b.value ? 1 : 0)
  const total = funded.reduce((sum,row) => sum + row.value, BigInt(0))
  const slices = funded.length > 6
    ? [...funded.slice(0,5), { name: 'Others', value: funded.slice(5).reduce((sum,row) => sum + row.value, BigInt(0)) }]
    : funded
  return { total, partial: rows.some(row => balanceValue(row) === null), slices }
}
export function amountIssue(amount: string, available: bigint | null): string | null {
  if (!amount) return null
  const value = units(amount)
  if (value === null || value <= BigInt(0)) return 'Enter a positive amount with up to 6 decimals.'
  if (available === null) return 'Source balance unavailable. Refresh balances before bridging.'
  return value > available ? 'Insufficient USDC balance on this chain.' : null
}
export function transactionLinks(result: BridgeResult | null, liveSteps: BridgeStep[] = [], source = result?.source.chain, destination = result?.destination.chain) {
  const steps = [...(result?.steps ?? []).filter(step => !liveSteps.some(live => live.name === step.name)), ...liveSteps]
  return steps.flatMap(step => {
    if (!step.txHash) return []
    const name = step.name.toLowerCase()
    const chain = name === 'mint' ? destination : ['approve','burn'].includes(name) ? source : null
    const href = step.explorerUrl ?? chain?.explorerUrl?.replace('{hash}', encodeURIComponent(step.txHash))
    if (!href) return []
    try { if (new URL(href).protocol !== 'https:') return [] } catch { return [] }
    return [{ label: name === 'mint' ? 'Arc' : chain?.name ?? step.name, href, hash: step.txHash, step: step.name }]
  })
}
export function bridgeStepName(name: string): string {
  const knownNames: Record<string, string> = {
    approve: 'Approve',
    burn: 'Burn',
    fetchattestation: 'Fetch Attestation',
    mint: 'Mint',
  }
  return knownNames[name.toLowerCase()] ?? name
}
export function bridgeStepStatus(state: BridgeStep['state'] | string): string {
  return { pending: 'Pending', success: 'Completed', error: 'Failed', failed: 'Failed', noop: 'Not required' }[state] ?? state
}
export function shortTransactionHash(hash: string): string {
  return hash.length > 10 ? `${hash.slice(0, 6)}...${hash.slice(-4)}` : hash
}
export type StageState = 'completed' | 'current' | 'pending' | 'failed'
export function progressStages(result: BridgeResult | null, loading: boolean, label: string, error: string | null, liveSteps: BridgeStep[] = []): StageState[] {
  const stages: StageState[] = ['pending','pending','pending','pending']
  if (result?.state === 'success') return ['completed','completed','completed','completed']
  for (const step of [...(result?.steps ?? []), ...liveSteps]) {
    const index = { approve: 0, burn: 1, fetchattestation: 2, mint: 3 }[step.name.toLowerCase()]
    if (index === undefined) continue
    stages[index] = step.state === 'error' ? 'failed' : ['success','noop'].includes(step.state) ? 'completed' : 'current'
  }
  if (stages[1] === 'completed' && stages[2] === 'pending') stages[2] = stages[3] === 'completed' ? 'completed' : 'current'
  if (loading && label.includes('attestation')) { stages[1] = 'completed'; stages[2] = 'current' }
  // The hook exposes wallet preparation, but not a live approval event.
  if (loading && !stages.includes('current')) stages[1] = 'current'
  if (error && !stages.includes('failed')) stages[stages.indexOf('current') >= 0 ? stages.indexOf('current') : 1] = 'failed'
  return stages
}

export interface BridgeEstimateDetails {
  providerFee?: string
  forwardingFee?: string
  approvalGasReserve?: string
  burnGasReserve?: string
}

const DECIMAL_AMOUNT = /^\d+(?:\.\d+)?$/

function serviceFee(estimate: EstimateResult, type: EstimateResult['fees'][number]['type']): string | undefined {
  const values = estimate.fees.flatMap(fee => fee.type === type && fee.amount !== null && !fee.error
    ? [`${fee.amount} ${fee.token}`]
    : [])
  return values.length ? values.join(' + ') : undefined
}

function gasReserve(estimate: EstimateResult, step: string): string | undefined {
  const values = estimate.gasFees.flatMap(fee => fee.name.toLowerCase() === step && fee.fees && !fee.error && DECIMAL_AMOUNT.test(fee.fees.fee)
    // Bridge Kit's installed CCTP runtime already returns this as a human-readable
    // decimal value. Preserve it verbatim instead of treating it as base units.
    ? [`${fee.fees.fee} ${fee.token}`]
    : [])
  return values.length ? values.join(' + ') : undefined
}

export function bridgeEstimateDetails(estimate: EstimateResult | null): BridgeEstimateDetails | null {
  if (!estimate) return null
  const providerFee = serviceFee(estimate, 'provider')
  const forwardingFee = serviceFee(estimate, 'forwarder')
  const approvalGasReserve = gasReserve(estimate, 'approve')
  const burnGasReserve = gasReserve(estimate, 'burn')
  return {
    ...(providerFee && { providerFee }),
    ...(forwardingFee && { forwardingFee }),
    ...(approvalGasReserve && { approvalGasReserve }),
    ...(burnGasReserve && { burnGasReserve }),
  }
}
