import { BatchFacilitatorClient } from '@circle-fin/x402-batching/server'
import { GatewayClient } from '@circle-fin/x402-batching/client'
import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { isValidWalletAddress } from '@/lib/wallet-validation'

const ARC_TESTNET_NETWORK = 'eip155:5042002'
const ARC_TESTNET_USDC = '0x3600000000000000000000000000000000000000'
const ARC_TESTNET_GATEWAY_WALLET = '0x0077777d7EBA4688BDeF3E311b846F25870A19B9'

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

const facilitator = new BatchFacilitatorClient({
  url: 'https://gateway-api-testnet.circle.com',
})

const gatewayClient = new GatewayClient({
  chain: 'arcTestnet',
  privateKey: PLATFORM_PRIVATE_KEY,
})

function buildPaymentRequirements(sellerPriceUsd: number) {
  const buyerAmount = Math.round(sellerPriceUsd * (1 + BUYER_FEE_RATE) * 1_000_000)
  return {
    scheme: 'exact' as const,
    network: ARC_TESTNET_NETWORK,
    asset: ARC_TESTNET_USDC,
    amount: buyerAmount.toString(),
    payTo: PLATFORM_ADDRESS,
    maxTimeoutSeconds: 345600,
    extra: {
      name: 'GatewayWalletBatched',
      version: '1',
      verifyingContract: ARC_TESTNET_GATEWAY_WALLET,
    },
  }
}

export function build402Response(sellerPriceUsd: number): NextResponse {
  const requirements = buildPaymentRequirements(sellerPriceUsd)
  const buyerPrice = (sellerPriceUsd * (1 + BUYER_FEE_RATE)).toFixed(6)
  const paymentRequired = {
    x402Version: 2,
    resource: {
      url: '/api/proxy',
      description: `API call — $${buyerPrice} USDC (incl. 10% platform fee)`,
      mimeType: 'application/json',
    },
    accepts: [requirements],
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
    const requirements = buildPaymentRequirements(sellerPriceUsd)
    const paymentPayload = JSON.parse(
      Buffer.from(paymentSignature, 'base64').toString('utf-8')
    )

    const verifyResult = await facilitator.verify(paymentPayload, requirements)
    if (!verifyResult.isValid) {
      return { success: false, error: `verification_failed: ${verifyResult.invalidReason}` }
    }

    const settleResult = await facilitator.settle(paymentPayload, requirements)
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

    console.log(`[payment] api=${apiId} buyer=${payer} buyer_paid=$${(sellerPriceUsd * 1.1).toFixed(6)} seller_gets=$${sellerShare.toFixed(6)} platform=$${(sellerPriceUsd * 0.2).toFixed(6)}`)

    const transferResult = await transferToSeller(sellerAddress, sellerShare, apiId)
    if (!transferResult.success) {
      console.error(`[transfer-failed] api=${apiId} seller=${sellerAddress} amount=$${sellerShare.toFixed(6)} buyer=${payer} error=${transferResult.error}`)
    }

    const supabase = createServiceClient()
    const { data: purchase } = await supabase
      .from('purchases')
      .insert({
        buyer_wallet: payer.toLowerCase(),
        api_id: apiId,
        amount_usdc: Math.round(sellerPriceUsd * 1.1 * 1_000_000) / 1_000_000,
        tx_hash: settleResult.transaction ?? `gateway-${Date.now()}`,
      })
      .select('id')
      .single()

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
): Promise<{ success: boolean; error?: string }> {
  try {
    const amountStr = amountUsd.toFixed(6)
    await gatewayClient.transfer(amountStr, 'arcTestnet', sellerAddress)
    console.log(`[transfer] $${amountStr} USDC -> seller ${sellerAddress} api=${apiId}`)
    return { success: true }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return { success: false, error: message }
  }
}
