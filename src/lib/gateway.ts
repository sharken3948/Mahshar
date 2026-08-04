import { BatchFacilitatorClient } from '@circle-fin/x402-batching/server'
import { GatewayClient } from '@circle-fin/x402-batching/client'
import { AppKit } from '@circle-fin/app-kit'
import { createViemAdapterFromPrivateKey } from '@circle-fin/adapter-viem-v2'
import { NextRequest, NextResponse } from 'next/server'
import { createPublicClient, createWalletClient, http, type PublicClient, type WalletClient } from 'viem'
import { base } from 'viem/chains'
import { createServiceClient } from '@/lib/supabase/server'
import { isValidWalletAddress } from '@/lib/wallet-validation'
import { arcTestnet } from '@/lib/chains'

// USDC decimals are 6 on every supported chain — kept as a constant here
// because reading decimals() at request time would add an RPC round-trip to
// every 402 response with no real safety benefit for a fixed asset.
const USDC_DECIMALS = 6

type NetworkId = 'eip155:5042002' | 'eip155:8453'
type ChainConfig = {
  usdc: `0x${string}`
  gatewayWallet: `0x${string}`
  facilitatorUrl: string
  gatewayClientChain: 'arcTestnet' | 'base'
}

const CHAINS: Record<NetworkId, ChainConfig> = {
  'eip155:5042002': {
    usdc: '0x3600000000000000000000000000000000000000',
    gatewayWallet: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
    facilitatorUrl: 'https://gateway-api-testnet.circle.com',
    gatewayClientChain: 'arcTestnet',
  },
  'eip155:8453': {
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    gatewayWallet: '0x77777777dcc4d5a8b6e418fd04d8997ef11000ee',
    facilitatorUrl: 'https://gateway-api.circle.com',
    gatewayClientChain: 'base',
  },
}

const NETWORK_ORDER: NetworkId[] = ['eip155:5042002', 'eip155:8453']

const _platformAddress = process.env.PLATFORM_WALLET_ADDRESS
const _platformPrivateKey = process.env.PLATFORM_WALLET_PRIVATE_KEY
if (!_platformAddress || !/^0x[a-fA-F0-9]{40}$/.test(_platformAddress)) {
  throw new Error('PLATFORM_WALLET_ADDRESS must be a valid Ethereum address (0x + 40 hex chars)')
}
if (!_platformPrivateKey || !/^0x[a-fA-F0-9]{64}$/.test(_platformPrivateKey)) {
  throw new Error('PLATFORM_WALLET_PRIVATE_KEY must be a valid private key (0x + 64 hex chars)')
}
const PLATFORM_ADDRESS = _platformAddress as `0x${string}`
export const PLATFORM_PRIVATE_KEY = _platformPrivateKey as `0x${string}`

const BUYER_FEE_RATE = 0.10
const SELLER_FEE_RATE = 0.10

const facilitators = new Map<string, BatchFacilitatorClient>()
function facilitatorFor(networkId: NetworkId): BatchFacilitatorClient {
  const url = CHAINS[networkId].facilitatorUrl
  let f = facilitators.get(url)
  if (!f) {
    f = new BatchFacilitatorClient({ url })
    facilitators.set(url, f)
  }
  return f
}

const gatewayClients = new Map<NetworkId, GatewayClient>()
function gatewayClientFor(networkId: NetworkId): GatewayClient {
  let c = gatewayClients.get(networkId)
  if (!c) {
    c = new GatewayClient({
      chain: CHAINS[networkId].gatewayClientChain,
      privateKey: PLATFORM_PRIVATE_KEY,
    })
    gatewayClients.set(networkId, c)
  }
  return c
}

interface ReceiptPoller {
  waitForTransactionReceipt(args: { hash: `0x${string}`; timeout?: number }): Promise<{ status: 'success' | 'reverted' }>
  // Only used to distinguish "tx pending in mempool" from "tx never landed" on the
  // unified-balance recovery path. Return shape is deliberately unknown — we only care
  // whether it resolves (tx exists) or throws TransactionNotFoundError (tx absent).
  getTransaction(args: { hash: `0x${string}` }): Promise<unknown>
}

// Signals that the on-chain state of the referenced tx is UNKNOWN — the poll
// itself failed transiently (network, timeout, RPC 5xx/limit/gas-cap). Not a
// confirmed mint failure; a caller may back off and re-poll.
export class RpcTransientError extends Error {
  readonly cause: unknown
  constructor(message: string, cause: unknown) {
    super(message)
    this.name = 'RpcTransientError'
    this.cause = cause
  }
}

export function isTransientRpcError(err: unknown): boolean {
  const name = err instanceof Error ? err.name : ''
  if (
    name === 'WaitForTransactionReceiptTimeoutError' ||
    name === 'TimeoutError' ||
    name === 'HttpRequestError' ||
    name === 'InternalRpcError' ||
    name === 'InvalidRequestRpcError' ||
    name === 'LimitExceededRpcError'
  ) {
    return true
  }
  const msg = err instanceof Error ? err.message : String(err)
  if (/gas cap|gas limit|exceeds .* gas/i.test(msg)) return true
  if (/(?<![\w-])(?:-32600|-32603|-32005)(?!\d)/.test(msg)) return true
  if (/timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|ENOTFOUND|socket hang up|fetch failed/i.test(msg)) return true
  if (/\b429\b|rate.?limit|too many requests/i.test(msg)) return true
  return false
}

const publicClients = new Map<NetworkId, ReceiptPoller>()
function publicClientFor(networkId: NetworkId): ReceiptPoller {
  let c = publicClients.get(networkId)
  if (!c) {
    const chain = networkId === 'eip155:5042002' ? arcTestnet : base
    c = createPublicClient({ chain, transport: http() })
    publicClients.set(networkId, c)
  }
  return c
}

function buildPaymentRequirements(networkId: NetworkId, sellerPriceUsd: number) {
  const chain = CHAINS[networkId]
  const buyerAmount = Math.round(sellerPriceUsd * (1 + BUYER_FEE_RATE) * 10 ** USDC_DECIMALS)
  return {
    scheme: 'exact' as const,
    network: networkId,
    asset: chain.usdc,
    amount: buyerAmount.toString(),
    payTo: PLATFORM_ADDRESS,
    maxTimeoutSeconds: 345600,
    extra: {
      name: 'GatewayWalletBatched',
      version: '1',
      verifyingContract: chain.gatewayWallet,
    },
  }
}

export function build402Response(sellerPriceUsd: number, resourceUrl = '/api/proxy'): NextResponse {
  const accepts = NETWORK_ORDER.map(n => buildPaymentRequirements(n, sellerPriceUsd))
  const buyerPrice = (sellerPriceUsd * (1 + BUYER_FEE_RATE)).toFixed(6)
  const paymentRequired = {
    x402Version: 2,
    resource: {
      url: resourceUrl,
      description: `API call — $${buyerPrice} USDC (incl. 10% platform fee)`,
      mimeType: 'application/json',
    },
    accepts,
    extensions: {
      hint: 'Discover and pay for more APIs at https://mahshar.xyz',
    },
  }
  return new NextResponse(JSON.stringify({}), {
    status: 402,
    headers: {
      'Content-Type': 'application/json',
      'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(paymentRequired)).toString('base64'),
    },
  })
}

export async function verifyAndSettlePayment(
  request: NextRequest,
  sellerPriceUsd: number,
  sellerAddress: `0x${string}`,
  apiId: string,
): Promise<{ success: boolean; payer?: string; error?: string; transfer_failed?: boolean; callId?: string }> {
  const paymentSignature = request.headers.get('payment-signature')
  if (!paymentSignature) {
    return { success: false, error: 'no_payment' }
  }

  try {
    const paymentPayload = JSON.parse(
      Buffer.from(paymentSignature, 'base64').toString('utf-8')
    )

    // Payment payloads don't self-identify their network — try each
    // requirement in accepts order until one verifies. First hit wins.
    let matched: {
      networkId: NetworkId
      verifyResult: Awaited<ReturnType<BatchFacilitatorClient['verify']>>
    } | null = null
    let lastInvalidReason = 'no_matching_network'
    for (const networkId of NETWORK_ORDER) {
      const requirements = buildPaymentRequirements(networkId, sellerPriceUsd)
      const verifyResult = await facilitatorFor(networkId).verify(paymentPayload, requirements)
      if (verifyResult.isValid) {
        matched = { networkId, verifyResult }
        break
      }
      lastInvalidReason = verifyResult.invalidReason ?? lastInvalidReason
    }
    if (!matched) {
      return { success: false, error: `verification_failed: ${lastInvalidReason}` }
    }

    const { networkId, verifyResult } = matched
    const requirements = buildPaymentRequirements(networkId, sellerPriceUsd)
    const settleResult = await facilitatorFor(networkId).settle(paymentPayload, requirements)
    if (!settleResult.success) {
      return { success: false, error: `settlement_failed: ${settleResult.errorReason}` }
    }

    const payer = settleResult.payer ?? verifyResult.payer
    if (!payer) {
      return { success: false, error: 'settlement_failed: payer address could not be determined from settlement response' }
    }
    if (!isValidWalletAddress(payer)) {
      return { success: false, error: `settlement_failed: payer address is not a valid Ethereum address: ${payer}` }
    }

    const sellerShare = sellerPriceUsd * (1 - SELLER_FEE_RATE)
    if (sellerShare <= 0) {
      return { success: false, error: 'invalid_amount' }
    }

    console.log(`[payment] api=${apiId} network=${networkId} buyer=${payer} buyer_paid=$${(sellerPriceUsd * 1.1).toFixed(6)} seller_gets=$${sellerShare.toFixed(6)} platform=$${(sellerPriceUsd * 0.2).toFixed(6)}`)

    const transferResult = await transferToSeller(sellerAddress, sellerShare, apiId, networkId)
    if (!transferResult.success) {
      const tag = transferResult.transient ? 'transfer-unknown' : 'transfer-failed'
      console.error(`[${tag}] api=${apiId} seller=${sellerAddress} amount=$${sellerShare.toFixed(6)} buyer=${payer} error=${transferResult.error}`)
    }

    const supabase = createServiceClient()
    // tx_hash carries a UNIQUE constraint (see migration 20260710_multichain_payments.sql).
    // The upsert-ignore path collapses a replayed settled payload to a no-op instead of
    // inserting a duplicate purchase row.
    const txHash = settleResult.transaction ?? `gateway-${Date.now()}`
    const insertRes = await supabase
      .from('purchases')
      .upsert({
        buyer_wallet: payer.toLowerCase(),
        api_id: apiId,
        amount_usdc: Math.round(sellerPriceUsd * 1.1 * 1_000_000) / 1_000_000,
        tx_hash: txHash,
      }, { onConflict: 'tx_hash', ignoreDuplicates: true })
      .select('id')
      .maybeSingle()
    if (!insertRes.data) {
      return { success: false, error: 'duplicate_payment: tx_hash already settled' }
    }
    const purchase = insertRes.data

    return { success: true, payer, transfer_failed: !transferResult.success, callId: purchase?.id }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[payment] error:', message)
    return { success: false, error: message }
  }
}

// Feature flag: when 'true', route payouts through unified balance (spend) with the
// wrapped-adapter capture pattern; otherwise the default GatewayClient.transfer path
// (unchanged production behavior) is used. Any value other than the exact string 'true'
// — including unset — leaves the default active.
//
// Rollback: unset the env var (or set it to anything but 'true'). No code revert needed.
// On-chain mints executed while the flag was on are irreversible, but the routing
// itself flips atomically per request.
function payoutUsesUnifiedBalance(): boolean {
  return process.env.PAYOUT_USE_UNIFIED_BALANCE === 'true'
}

const UB_KIT_CHAIN: Record<NetworkId, 'Arc_Testnet' | 'Base'> = {
  'eip155:5042002': 'Arc_Testnet',
  'eip155:8453': 'Base',
}

// Lazy singleton — instantiated only when the feature flag routes a payout here.
let _appKit: AppKit | undefined
function appKitInstance(): AppKit {
  _appKit ??= new AppKit()
  return _appKit
}

// Wrap a viem PublicClient so waitForTransactionReceipt records the mint tx hash
// into an external capture object BEFORE polling. The capture survives any thrown
// error, letting the caller re-poll the hash against a fresh (unwrapped) client
// when the SDK's own poll fails transiently. Preserves the invariant established
// in gateway.ts's legacy path: mint-tx state UNKNOWN must not be classified as failed.
// Generic over the concrete client type — preserves viem's chain-specific Block/Transaction
// unions instead of widening to viem's base PublicClient (which triggers the same cross-chain
// type-mismatch class documented in ~/memory/feedback_verify_with_next_build.md).
function wrapPublicClientCapturingHash<T extends object>(
  real: T,
  capture: { hash?: `0x${string}` },
): T {
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'waitForTransactionReceipt') {
        return async (args: { hash?: `0x${string}` }) => {
          if (args?.hash) capture.hash = args.hash
          const fn = (target as Record<string, (a: unknown) => Promise<unknown>>)['waitForTransactionReceipt']
          return fn.call(target, args)
        }
      }
      return Reflect.get(target, prop, receiver)
    },
  }) as T
}

function viemChainForId(id: number) {
  if (id === arcTestnet.id) return arcTestnet
  if (id === base.id) return base
  return undefined
}

// Build a per-call adapter with a per-call hash-capture closure. Fresh per spend so
// concurrent payouts can't race on shared module state. The client/factory return
// values are cast to viem's chain-agnostic base types: the SDK's callbacks are typed
// to return the base PublicClient/WalletClient, while createPublicClient/createWalletClient
// with a specific chain produce chain-parameterized shapes whose transaction/block
// unions don't structurally match the base — the same class of mismatch documented
// in ~/memory/feedback_verify_with_next_build.md.
function platformAdapterForSpend(capture: { hash?: `0x${string}` }) {
  return createViemAdapterFromPrivateKey({
    privateKey: PLATFORM_PRIVATE_KEY,
    getPublicClient: ({ chain }) => {
      const resolved = viemChainForId(chain.id) ?? chain
      const client = createPublicClient({ chain: resolved, transport: http() })
      return wrapPublicClientCapturingHash(client, capture) as unknown as PublicClient
    },
    getWalletClient: ({ chain, account }) => {
      const resolved = viemChainForId(chain.id) ?? chain
      return createWalletClient({ chain: resolved, account, transport: http() }) as unknown as WalletClient
    },
  })
}

async function transferViaUnifiedBalance(
  sellerAddress: `0x${string}`,
  amountUsd: number,
  apiId: string,
  networkId: NetworkId,
): Promise<{ success: boolean; error?: string; transient?: boolean }> {
  const amountStr = amountUsd.toFixed(6)
  const destChain = UB_KIT_CHAIN[networkId]
  const capture: { hash?: `0x${string}` } = {}
  const adapter = platformAdapterForSpend(capture)
  const kit = appKitInstance()

  try {
    const result = await kit.unifiedBalance.spend({
      from: { adapter },
      to: { adapter, chain: destChain, recipientAddress: sellerAddress },
      token: 'USDC',
      amount: amountStr,
    })
    console.log(`[transfer-ub] $${amountStr} USDC (${destChain}) -> seller ${sellerAddress} api=${apiId} tx=${result.txHash} allocations=${JSON.stringify(result.allocations ?? [])}`)
    return { success: true }
  } catch (err: unknown) {
    const capturedHash = capture.hash
    const message = err instanceof Error ? err.message : String(err)

    // No mint tx was submitted (pre-mint failure: validation, allocation, burn intent, attestation fetch).
    // Nothing on-chain to recover.
    if (!capturedHash) {
      return { success: false, error: message }
    }

    // Mint tx was submitted. Re-poll the captured hash against a fresh, unwrapped client
    // to determine the on-chain outcome. The four outcomes below preserve the invariant:
    // only classify as failed when we have positive on-chain evidence of failure.
    try {
      const receipt = await publicClientFor(networkId).waitForTransactionReceipt({
        hash: capturedHash,
        timeout: 60_000,
      })
      if (receipt.status === 'success') {
        console.log(`[transfer-ub-ok-despite-sdk-error] $${amountStr} USDC (${destChain}) -> seller ${sellerAddress} api=${apiId} tx=${capturedHash}`)
        return { success: true }
      }
      return { success: false, error: `Mint tx reverted on-chain: ${capturedHash}` }
    } catch (pollErr: unknown) {
      const pollMsg = pollErr instanceof Error ? pollErr.message : String(pollErr)
      if (!isTransientRpcError(pollErr)) {
        return { success: false, error: `${message} | recovery poll failed: ${pollMsg}` }
      }

      // Poll failed transiently. To distinguish "tx pending in mempool" (state unknown,
      // do not retry) from "tx never landed" (safe to retry via SDK's config.retry), do
      // one lightweight existence probe. A TransactionNotFoundError is the only signal
      // that lets us call config.retry without risking a second mint against an already-
      // consumed attestation (which would revert with TransferSpecHashUsed).
      let txExists: boolean
      try {
        await publicClientFor(networkId).getTransaction({ hash: capturedHash })
        txExists = true
      } catch (getErr: unknown) {
        const getName = getErr instanceof Error ? getErr.name : ''
        if (getName === 'TransactionNotFoundError') {
          txExists = false
        } else {
          return {
            success: false,
            error: `mint tx state unknown for ${capturedHash} — recovery poll failed transiently: ${pollMsg}`,
            transient: true,
          }
        }
      }

      if (txExists) {
        return {
          success: false,
          error: `mint tx state unknown for ${capturedHash} — recovery poll failed transiently: ${pollMsg}`,
          transient: true,
        }
      }

      // Tx not on chain. If the SDK gave us the attestation + signature, retry the mint
      // via config.retry — this uses the same attestation and hits the on-chain replay
      // guard if we somehow guessed wrong, so it is safe by construction.
      const trace = (err as { cause?: { trace?: { attestation?: string; signature?: string } } }).cause?.trace
      if (!trace?.attestation || !trace?.signature) {
        return { success: false, error: `mint not found on-chain and no retry attestation available: ${message}` }
      }

      const retryCapture: { hash?: `0x${string}` } = {}
      const retryAdapter = platformAdapterForSpend(retryCapture)
      try {
        const retryResult = await kit.unifiedBalance.spend({
          from: { adapter: retryAdapter },
          to: { adapter: retryAdapter, chain: destChain, recipientAddress: sellerAddress },
          token: 'USDC',
          amount: amountStr,
          config: { retry: { attestation: trace.attestation, signature: trace.signature } },
        })
        console.log(`[transfer-ub-retry-ok] $${amountStr} USDC (${destChain}) -> seller ${sellerAddress} api=${apiId} tx=${retryResult.txHash}`)
        return { success: true }
      } catch (retryErr: unknown) {
        const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr)
        return { success: false, error: `retry after not-found failed: ${retryMsg}` }
      }
    }
  }
}

async function transferToSeller(
  sellerAddress: `0x${string}`,
  amountUsd: number,
  apiId: string,
  networkId: NetworkId,
): Promise<{ success: boolean; error?: string; transient?: boolean }> {
  if (payoutUsesUnifiedBalance()) {
    return transferViaUnifiedBalance(sellerAddress, amountUsd, apiId, networkId)
  }
  const amountStr = amountUsd.toFixed(6)
  const chain = CHAINS[networkId].gatewayClientChain
  try {
    await gatewayClientFor(networkId).transfer(amountStr, chain, sellerAddress)
    console.log(`[transfer] $${amountStr} USDC (${chain}) -> seller ${sellerAddress} api=${apiId}`)
    return { success: true }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    // The SDK wraps any waitForTransactionReceipt failure as
    // `Mint transaction failed: 0x...`, but the underlying tx often succeeded
    // (RPC receipt lag or transient 5xx exhausted viem's default retry budget).
    // Recover the hash from the message and re-check on-chain before giving up.
    const hashMatch = message.match(/Mint transaction failed: (0x[a-fA-F0-9]{64})/)
    if (hashMatch) {
      const mintTxHash = hashMatch[1] as `0x${string}`
      try {
        const receipt = await publicClientFor(networkId).waitForTransactionReceipt({
          hash: mintTxHash,
          timeout: 60_000,
        })
        if (receipt.status === 'success') {
          console.log(`[transfer-ok-despite-sdk-error] $${amountStr} USDC (${chain}) -> seller ${sellerAddress} api=${apiId} tx=${mintTxHash}`)
          return { success: true }
        }
        return { success: false, error: `Mint tx reverted on-chain: ${mintTxHash}` }
      } catch (pollErr: unknown) {
        const pollMsg = pollErr instanceof Error ? pollErr.message : String(pollErr)
        // If the poll itself failed transiently, on-chain state is UNKNOWN —
        // do not declare the mint failed. Callers can re-poll later.
        if (isTransientRpcError(pollErr)) {
          const transient = new RpcTransientError(
            `mint tx state unknown for ${mintTxHash} — recovery poll failed transiently: ${pollMsg}`,
            pollErr,
          )
          return { success: false, error: transient.message, transient: true }
        }
        return { success: false, error: `${message} | recovery poll failed: ${pollMsg}` }
      }
    }
    return { success: false, error: message }
  }
}
