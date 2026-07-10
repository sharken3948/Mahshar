import { BatchFacilitatorClient } from '@circle-fin/x402-batching/server'
import { GatewayClient } from '@circle-fin/x402-batching/client'
import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { isValidWalletAddress } from '@/lib/wallet-validation'

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
      console.error(`[transfer-failed] api=${apiId} seller=${sellerAddress} amount=$${sellerShare.toFixed(6)} buyer=${payer} error=${transferResult.error}`)
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

async function transferToSeller(
  sellerAddress: `0x${string}`,
  amountUsd: number,
  apiId: string,
  networkId: NetworkId,
): Promise<{ success: boolean; error?: string }> {
  try {
    const amountStr = amountUsd.toFixed(6)
    const chain = CHAINS[networkId].gatewayClientChain
    await gatewayClientFor(networkId).transfer(amountStr, chain, sellerAddress)
    console.log(`[transfer] $${amountStr} USDC (${chain}) -> seller ${sellerAddress} api=${apiId}`)
    return { success: true }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return { success: false, error: message }
  }
}
