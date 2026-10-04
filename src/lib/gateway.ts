import { BatchFacilitatorClient } from '@circle-fin/x402-batching/server'
import { NextRequest, NextResponse } from 'next/server'
import { parsePayment, settleDurably, type SettlementResult } from '@/lib/payments/settlement'
import { settlementStorageReady, settlementStore } from '@/lib/payments/server'
import { ARC_MAINNET } from '@/lib/arc'
import { encodePaymentResponseHeader } from '@x402/core/http'
import type { Network } from '@x402/core/types'
import { marketplaceOrigin } from '@/lib/marketplace/server'
import { verifyPlatformWalletConfiguration } from '@/lib/platform-wallet-config'

// USDC decimals are 6 on every supported chain — kept as a constant here
// because reading decimals() at request time would add an RPC round-trip to
// every 402 response with no real safety benefit for a fixed asset.
const USDC_DECIMALS = 6

type NetworkId = 'eip155:5042'
type ChainConfig = {
  usdc: `0x${string}`
  gatewayWallet: `0x${string}`
  gatewayMinter?: `0x${string}`
  facilitatorUrl: string
  gatewayClientChain: 'arc'
}

const CHAINS: Record<NetworkId, ChainConfig> = {
  'eip155:5042': {
    usdc: ARC_MAINNET.usdcAddress,
    gatewayWallet: ARC_MAINNET.gatewayWallet,
    gatewayMinter: '0x2222222d7164433c4C09B0b0D809a9b52C04C205',
    facilitatorUrl: 'https://gateway-api.circle.com',
    gatewayClientChain: 'arc',
  },
}

const NETWORK_ORDER: NetworkId[] = ['eip155:5042']

const platformWallet = verifyPlatformWalletConfiguration()
const PLATFORM_ADDRESS = platformWallet.address
export const PLATFORM_PRIVATE_KEY = platformWallet.privateKey

const BUYER_FEE_RATE = 0.10
const SELLER_FEE_RATE = 0.10

const facilitators = new Map<string, BatchFacilitatorClient>()
function facilitatorFor(networkId: NetworkId): BatchFacilitatorClient {
  const url = CHAINS[networkId].facilitatorUrl
  let f = facilitators.get(url)
  if (!f) {
    // Arc Mainnet is behind the X-ARC-PRIVATE-MAINNET-ENABLED header until Circle's public GA;
    // without it, verify/settle against gateway-api.circle.com treats eip155:5042 as unsupported.
    const arcPrivateMainnet = networkId === 'eip155:5042'
    f = new BatchFacilitatorClient({ url, arcPrivateMainnet })
    facilitators.set(url, f)
  }
  return f
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
      hint: `Discover and pay for more APIs at ${marketplaceOrigin()}`,
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

export async function paymentInfrastructureStatus(): Promise<
  { ready: true } | { ready: false; error: 'payment_storage_unavailable'; status: 503 }
> {
  try {
    await settlementStorageReady()
    return { ready: true }
  } catch {
    return { ready: false, error: 'payment_storage_unavailable', status: 503 }
  }
}

export async function verifyAndSettlePayment(
  request: NextRequest,
  sellerPriceUsd: number,
  sellerAddress: `0x${string}`,
  apiId: string,
): Promise<SettlementResult> {
  const signature = request.headers.get('payment-signature')
  if (!signature) return { success: false, error: 'no_payment', status: 402 }
  let payment: ReturnType<typeof parsePayment>
  try { payment = parsePayment(signature) }
  catch { return { success: false, error: 'invalid_payment', status: 400 } }
  const sellerAtomic = Math.round(sellerPriceUsd * (1 - SELLER_FEE_RATE) * 10 ** USDC_DECIMALS)
  if (!Number.isSafeInteger(sellerAtomic) || sellerAtomic <= 0) return { success: false, error: 'invalid_amount', status: 400 }
  return settleDurably({
    payment, apiId, seller: sellerAddress, sellerAtomic: String(sellerAtomic),
    candidates: NETWORK_ORDER.map(n => buildPaymentRequirements(n, sellerPriceUsd)),
    facilitator: network => facilitatorFor(network as NetworkId), store: settlementStore(),
  })
}

/** Standard x402 v2 settlement metadata consumed by Circle and third-party clients. */
export function paymentResponseHeader(result: SettlementResult): string {
  if (!result.success || !result.payer || !result.network) throw new Error('Settlement metadata unavailable')
  return encodePaymentResponseHeader({
    success: true,
    payer: result.payer,
    transaction: result.transaction ?? '',
    network: result.network as Network,
    amount: result.amount,
  })
}
