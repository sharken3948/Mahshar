import 'server-only'

import { randomBytes } from 'node:crypto'
import { pad, parseUnits, type Hex } from 'viem'
import { ARC } from '@/lib/arc'
import { formatUsdcMicros, PLATFORM_COMMISSION_DESTINATION, usdcMicros } from './gateway-treasury-calculation'
import { classifyGatewayTransferResponse, classifyGatewayTransferStatus,
  type GatewayTransferAccepted } from '@/lib/withdrawal-outcome'

export { PLATFORM_COMMISSION_DESTINATION } from './gateway-treasury-calculation'
const NATIVE_TO_USDC = BigInt(10) ** BigInt(12)
const GAS_FALLBACK = BigInt(140_000)
const MAX_AMOUNT = BigInt(10_000) * BigInt(1_000_000)

export function hasArcMintGas(nativeWei: bigint, estimatedGasUsdc: string): boolean {
  return nativeWei >= usdcMicros(estimatedGasUsdc) * NATIVE_TO_USDC
}

const BURN_INTENT_TYPES = {
  EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }],
  TransferSpec: [
    { name: 'version', type: 'uint32' }, { name: 'sourceDomain', type: 'uint32' },
    { name: 'destinationDomain', type: 'uint32' }, { name: 'sourceContract', type: 'bytes32' },
    { name: 'destinationContract', type: 'bytes32' }, { name: 'sourceToken', type: 'bytes32' },
    { name: 'destinationToken', type: 'bytes32' }, { name: 'sourceDepositor', type: 'bytes32' },
    { name: 'destinationRecipient', type: 'bytes32' }, { name: 'sourceSigner', type: 'bytes32' },
    { name: 'destinationCaller', type: 'bytes32' }, { name: 'value', type: 'uint256' },
    { name: 'salt', type: 'bytes32' }, { name: 'hookData', type: 'bytes' },
  ],
  BurnIntent: [{ name: 'maxBlockHeight', type: 'uint256' },
    { name: 'maxFee', type: 'uint256' }, { name: 'spec', type: 'TransferSpec' }],
} as const

function bytes32(address: string): Hex { return pad(address.toLowerCase() as Hex, { size: 32 }) }
function jsonBigint(_key: string, value: unknown) { return typeof value === 'bigint' ? value.toString() : value }
function bounded(error: unknown) { return (error instanceof Error ? error.message : String(error)).slice(0, 2048) }

export function commissionAmount(value: unknown): bigint {
  const amount = usdcMicros(value)
  if (amount < BigInt(50_000) || amount > MAX_AMOUNT) throw new Error('Commission amount is outside the permitted range')
  return amount
}

export function commissionSpec(platform: string, value: bigint, salt: Hex) {
  if (platform.toLowerCase() !== PLATFORM_COMMISSION_DESTINATION.toLowerCase()) {
    throw new Error('Platform commission destination mismatch')
  }
  return {
    version: 1, sourceDomain: ARC.gatewayDomain, destinationDomain: ARC.gatewayDomain,
    sourceContract: bytes32(ARC.gatewayWallet), destinationContract: bytes32(ARC.gatewayMinter),
    sourceToken: bytes32(ARC.usdcAddress), destinationToken: bytes32(ARC.usdcAddress),
    sourceDepositor: bytes32(platform), destinationRecipient: bytes32(PLATFORM_COMMISSION_DESTINATION),
    sourceSigner: bytes32(platform), destinationCaller: bytes32(platform),
    value, salt, hookData: '0x' as Hex,
  }
}

export type CommissionQuote = {
  amount_usdc: string
  source_fee_estimate_usdc: string
  source_fee_cap_usdc: string
  destination_gas_estimate_usdc: string
  mint_value_usdc: string
  max_block_height: string
  destination: string
}

export async function quoteCommission(amount: bigint, platform: string, options: {
  fetchEstimate?: typeof fetch
  getGasPrice: () => Promise<bigint>
}): Promise<CommissionQuote> {
  commissionAmount(formatUsdcMicros(amount))
  const spec = commissionSpec(platform, amount, `0x${'00'.repeat(32)}` as Hex)
  const response = await (options.fetchEstimate ?? fetch)(`${ARC.gatewayApi}/estimate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-ARC-PRIVATE-MAINNET-ENABLED': 'true' },
    body: JSON.stringify([{ spec }], jsonBigint), signal: AbortSignal.timeout(8_000), cache: 'no-store',
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error('Circle fee estimate unavailable')
  }
  const body = await response.json() as Array<{ burnIntent?: { maxFee?: unknown; maxBlockHeight?: unknown;
    spec?: { value?: unknown; sourceDomain?: unknown; destinationDomain?: unknown } } }>
  const intent = Array.isArray(body) && body.length === 1 ? body[0]?.burnIntent : null
  if (!intent || typeof intent.maxFee !== 'string' || !/^(?:0|[1-9]\d*)$/.test(intent.maxFee) ||
    typeof intent.maxBlockHeight !== 'string' || !/^[1-9]\d*$/.test(intent.maxBlockHeight) ||
    intent.spec?.value !== amount.toString() || intent.spec.sourceDomain !== ARC.gatewayDomain ||
    intent.spec.destinationDomain !== ARC.gatewayDomain) throw new Error('Circle fee estimate invalid')
  const estimated = BigInt(intent.maxFee)
  if (estimated <= 0) throw new Error('Circle fee estimate invalid')
  const cap = (estimated * BigInt(120) + BigInt(99)) / BigInt(100) + BigInt(500)
  if (cap >= amount) throw new Error('Commission amount does not cover Gateway source fee')
  const gasPrice = await options.getGasPrice()
  if (gasPrice <= 0) throw new Error('Arc gas estimate unavailable')
  const gasNative = (GAS_FALLBACK * gasPrice * BigInt(120) + BigInt(99)) / BigInt(100)
  const gasMicros = (gasNative + NATIVE_TO_USDC - BigInt(1)) / NATIVE_TO_USDC
  return {
    amount_usdc: formatUsdcMicros(amount),
    source_fee_estimate_usdc: formatUsdcMicros(estimated),
    source_fee_cap_usdc: formatUsdcMicros(cap),
    destination_gas_estimate_usdc: formatUsdcMicros(gasMicros),
    mint_value_usdc: formatUsdcMicros(amount - cap),
    max_block_height: intent.maxBlockHeight,
    destination: PLATFORM_COMMISSION_DESTINATION,
  }
}

export type CommissionRow = {
  id: string; status: string; amount_usdc: string | number; mint_value_usdc: string | number;
  source_fee_cap_usdc: string | number; destination_gas_estimate_usdc: string | number;
  attestation?: Hex | null; attestation_signature?: Hex | null;
  gateway_transfer_id?: string | null; mint_tx_hash?: Hex | null
}
type Store = {
  reserve: (args: { idempotencyKey: string; quote: CommissionQuote; gatewayAvailable: string }) => Promise<CommissionRow>
  get: (id: string) => Promise<CommissionRow | null>
  transition: (id: string, from: string, update: Record<string, unknown>) => Promise<boolean>
}
type Services = {
  preflight: (gatewayAvailable: string, quote: CommissionQuote, withdrawalId: string) => Promise<void>
  sign: (intent: ReturnType<typeof burnIntent>) => Promise<Hex>
  submit: (intent: ReturnType<typeof burnIntent>, signature: Hex) => Promise<{ status: number; body: unknown }>
  mint: (attestation: Hex, signature: Hex) => Promise<Hex>
  receipt: (hash: Hex) => Promise<'success' | 'reverted'>
  transferStatus: (id: string) => Promise<unknown>
}
export type CommissionWithdrawalDependencies = { store: Store; services: Services }

function burnIntent(platform: string, quote: CommissionQuote) {
  return {
    maxBlockHeight: BigInt(quote.max_block_height),
    maxFee: parseUnits(quote.source_fee_cap_usdc, 6),
    spec: commissionSpec(platform, parseUnits(quote.mint_value_usdc, 6),
      `0x${randomBytes(32).toString('hex')}` as Hex),
  }
}

export function signCommissionIntent(account: {
  signTypedData: (args: { domain: { name: 'GatewayWallet'; version: '1' };
    types: typeof BURN_INTENT_TYPES; primaryType: 'BurnIntent'; message: ReturnType<typeof burnIntent> }) => Promise<Hex>
}, intent: ReturnType<typeof burnIntent>) {
  return account.signTypedData({ domain: { name: 'GatewayWallet', version: '1' },
    types: BURN_INTENT_TYPES, primaryType: 'BurnIntent', message: intent })
}

export async function executeCommissionWithdrawal(
  deps: CommissionWithdrawalDependencies,
  input: { idempotencyKey: string; quote: CommissionQuote; gatewayAvailable: string; platform: string },
): Promise<CommissionRow> {
  const row = await deps.store.reserve(input)
  if (row.status !== 'reserved') return row
  const claimed = await deps.store.transition(row.id, 'reserved', { status: 'preparing' })
  if (!claimed) return (await deps.store.get(row.id)) ?? row

  const intent = burnIntent(input.platform, input.quote)
  const serializedIntent = JSON.parse(JSON.stringify(intent, jsonBigint))
  let signature: Hex
  try {
    if (!await deps.store.transition(row.id, 'preparing', { burn_intent: serializedIntent })) {
      throw new Error('Could not persist burn intent')
    }
    await deps.services.preflight(input.gatewayAvailable, input.quote, row.id)
    signature = await deps.services.sign(intent)
  } catch (error) {
    await deps.store.transition(row.id, 'preparing', { status: 'expired', last_error: bounded(error) })
    return (await deps.store.get(row.id)) ?? row
  }

  // From this durable marker onward, network ambiguity must keep the reservation locked.
  if (!await deps.store.transition(row.id, 'preparing', {
    status: 'submission_unknown', gateway_submitted_at: new Date().toISOString(),
    last_error: 'Gateway submission started; outcome not yet known',
  })) return (await deps.store.get(row.id)) ?? row

  let accepted: GatewayTransferAccepted
  try {
    const response = await deps.services.submit(intent, signature)
    const outcome = classifyGatewayTransferResponse(response.status, response.body)
    if (outcome.kind === 'rejected') {
      await deps.store.transition(row.id, 'submission_unknown', {
        status: 'expired', gateway_transfer_id: outcome.transferId,
        last_error: `Gateway confirmed rejection: ${outcome.detail}`,
      })
      return (await deps.store.get(row.id)) ?? row
    }
    if (outcome.kind === 'unknown') {
      await deps.store.transition(row.id, 'submission_unknown', {
        gateway_transfer_id: outcome.transferId, last_error: outcome.detail,
      })
      return (await deps.store.get(row.id)) ?? row
    }
    accepted = outcome
  } catch (error) {
    await deps.store.transition(row.id, 'submission_unknown', { last_error: bounded(error) })
    return (await deps.store.get(row.id)) ?? row
  }
  if (!await deps.store.transition(row.id, 'submission_unknown', {
    status: 'pending_mint', attestation: accepted.attestation,
    attestation_signature: accepted.signature, gateway_transfer_id: accepted.transferId, last_error: null,
  })) return (await deps.store.get(row.id)) ?? row
  return submitCommissionMint(deps, row.id, accepted.attestation, accepted.signature)
}

async function submitCommissionMint(deps: CommissionWithdrawalDependencies, id: string,
  attestation: Hex, signature: Hex): Promise<CommissionRow> {
  if (!await deps.store.transition(id, 'pending_mint', {
    status: 'mint_unknown', last_error: 'Arc mint submission started; hash not yet known',
  })) return (await deps.store.get(id))!
  let hash: Hex
  try { hash = await deps.services.mint(attestation, signature) }
  catch (error) {
    await deps.store.transition(id, 'mint_unknown', { last_error: bounded(error) })
    return (await deps.store.get(id))!
  }
  if (!await deps.store.transition(id, 'mint_unknown', {
    status: 'pending_mint', mint_tx_hash: hash, last_error: null,
  })) return (await deps.store.get(id))!
  return confirmCommissionReceipt(deps, id, hash)
}

async function confirmCommissionReceipt(deps: CommissionWithdrawalDependencies, id: string, hash: Hex,
  from: 'pending_mint' | 'mint_unknown' = 'pending_mint') {
  try {
    const receipt = await deps.services.receipt(hash)
    await deps.store.transition(id, from, {
      status: receipt === 'success' ? 'minted' : 'failed', mint_tx_hash: hash,
      minted_at: receipt === 'success' ? new Date().toISOString() : null,
      last_error: receipt === 'success' ? null : 'Arc mint reverted',
    })
  } catch (error) {
    await deps.store.transition(id, from, { last_error: bounded(error) })
  }
  return (await deps.store.get(id))!
}

export async function reconcileCommissionWithdrawal(deps: CommissionWithdrawalDependencies, id: string) {
  let row = await deps.store.get(id)
  if (!row) return null
  if (row.status === 'reserved' || row.status === 'preparing') {
    // CAS also fences a still-running request: it cannot cross the submission
    // marker after cancellation. No Gateway request exists before that marker.
    await deps.store.transition(id, row.status, {
      status: 'expired', last_error: 'Cancelled before Gateway submission; obtain and confirm a fresh quote',
    })
    return deps.store.get(id)
  }
  if (row.status === 'submission_unknown') {
    if (!row.gateway_transfer_id) return row // Manual evidence required; never repost /transfer.
    let status
    try { status = classifyGatewayTransferStatus(await deps.services.transferStatus(row.gateway_transfer_id)) }
    catch { return row }
    if (status.kind === 'rejected') {
      await deps.store.transition(id, 'submission_unknown', { status: 'expired', last_error: status.detail })
      return deps.store.get(id)
    }
    if (status.kind !== 'accepted') return row
    if (!await deps.store.transition(id, 'submission_unknown', {
      status: 'pending_mint', attestation: status.attestation,
      attestation_signature: status.signature, last_error: null,
    })) return deps.store.get(id)
    row = await deps.store.get(id)
  }
  if (row?.status === 'pending_mint' && row.mint_tx_hash) {
    return confirmCommissionReceipt(deps, id, row.mint_tx_hash)
  }
  if (row?.status === 'mint_unknown' && row.mint_tx_hash) {
    return confirmCommissionReceipt(deps, id, row.mint_tx_hash, 'mint_unknown')
  }
  if (row?.status === 'pending_mint' && row.attestation && row.attestation_signature) {
    return submitCommissionMint(deps, id, row.attestation, row.attestation_signature)
  }
  // mint_unknown without a hash requires authoritative transaction evidence.
  return row
}
