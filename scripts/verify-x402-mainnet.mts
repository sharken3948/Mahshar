import { config } from 'dotenv'
import { resolve } from 'node:path'
import { GatewayClient } from '@circle-fin/x402-batching/client'
import { getAddress, isAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { ARC_MAINNET } from '../src/lib/arc'

config({ path: resolve(process.cwd(), '.env.local'), quiet: true })

const TARGET_URL = 'https://mahshar.xyz/api/proxy/34c7a931-81de-4b8b-81ac-0916b4316989'
const ARC_MAINNET_NETWORK = 'eip155:5042'
const REQUIRED_AMOUNT_ATOMIC = BigInt(1100)
const REQUEST_BODY = JSON.stringify({
  address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
  chain: 'arc',
})

interface PaymentOption {
  scheme?: string
  network?: string
  asset?: string
  amount?: string
  payTo?: string
  extra?: {
    name?: string
    version?: string
    verifyingContract?: string
  }
}

interface PaymentRequired {
  x402Version?: number
  resource?: unknown
  accepts?: PaymentOption[]
}

interface CapturedPaidRequest {
  method: string
  body: string
  paymentSignature: string
  contentType: string
}

function fail(message: string): never {
  throw new Error(message)
}

function flagValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index === -1) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) fail(`${name} requires a value`)
  return value
}

function maskAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

function sameAddress(left: string, right: string): boolean {
  return isAddress(left) && isAddress(right) && getAddress(left) === getAddress(right)
}

function safeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw
    .replace(/0x[a-fA-F0-9]{64,}/g, '0x[redacted]')
    .replace(/[A-Za-z0-9+/=]{80,}/g, '[redacted]')
}

function decodePaymentRequired(header: string): PaymentRequired {
  try {
    return JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as PaymentRequired
  } catch {
    return fail('PAYMENT-REQUIRED is not valid base64-encoded JSON')
  }
}

function validatePaymentRequired(
  paymentRequired: PaymentRequired,
  expectedAmount: bigint,
  expectedPayTo: string,
): PaymentOption {
  if (paymentRequired.x402Version !== 2) {
    fail(`Unexpected x402 version: ${String(paymentRequired.x402Version)}`)
  }

  const accepts = paymentRequired.accepts
  if (!Array.isArray(accepts) || accepts.length === 0) {
    fail('The 402 response does not contain payment options')
  }

  const mainnetOptions = accepts.filter(option => option.network === ARC_MAINNET_NETWORK)
  if (mainnetOptions.length !== 1) {
    fail(`Expected exactly one ${ARC_MAINNET_NETWORK} payment option; found ${mainnetOptions.length}`)
  }

  const selected = mainnetOptions[0]
  if (accepts.length !== 1) fail('Only Arc Mainnet may be advertised')
  if (selected.scheme !== 'exact') {
    fail(`Unexpected payment scheme: ${String(selected.scheme)}`)
  }
  if (selected.extra?.name !== 'GatewayWalletBatched' || selected.extra.version !== '1') {
    fail('Unexpected Gateway payment scheme name or version')
  }
  if (selected.amount !== expectedAmount.toString()) {
    fail(`Unexpected payment amount: expected ${expectedAmount.toString()} atomic USDC`)
  }
  if (!selected.payTo || !sameAddress(selected.payTo, expectedPayTo)) {
    fail('The payment recipient does not match PLATFORM_WALLET_ADDRESS')
  }
  if (!selected.asset || !sameAddress(selected.asset, ARC_MAINNET.usdcAddress)) {
    fail('The payment asset does not match the configured Arc Mainnet USDC address')
  }
  if (
    !selected.extra.verifyingContract ||
    !sameAddress(selected.extra.verifyingContract, ARC_MAINNET.gatewayWallet)
  ) {
    fail('The EIP-712 verifying contract does not match the configured Arc Mainnet Gateway Wallet')
  }

  return selected
}

async function fetchPreflight(expectedAmount: bigint, expectedPayTo: string): Promise<PaymentOption> {
  const response = await fetch(TARGET_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: REQUEST_BODY,
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  })

  if (response.status !== 402) {
    fail(`Preflight expected HTTP 402 but received ${response.status}`)
  }

  const header = response.headers.get('PAYMENT-REQUIRED')
  if (!header) fail('Preflight 402 is missing PAYMENT-REQUIRED')
  await response.body?.cancel().catch(() => undefined)
  return validatePaymentRequired(decodePaymentRequired(header), expectedAmount, expectedPayTo)
}

function printSideEffects(): void {
  console.log('\nREAL-MONEY SIDE EFFECTS WHEN --execute IS PRESENT:')
  console.log('- Buyer Arc Mainnet Gateway balance: debit exactly 0.001100 USDC')
  console.log('- Production database: create one real purchase')
  console.log('- Production database: create one api_calls entry')
  console.log('- Seller accounting: credit 0.000900 USDC')
  console.log('- Platform economic share: 0.000200 USDC')
  console.log('- Platform wallet: may pay a small Arc gas cost for the memo transaction\n')
}

async function executePayment(
  expectedAmount: bigint,
  expectedPayTo: string,
  replayOnce: boolean,
): Promise<void> {
  const buyerPrivateKey = process.env.BUYER_PRIVATE_KEY
  if (!buyerPrivateKey || !/^0x[a-fA-F0-9]{64}$/.test(buyerPrivateKey)) {
    fail('BUYER_PRIVATE_KEY must be a valid 0x-prefixed private key')
  }

  const rpcUrl = process.env.ARC_MAINNET_RPC_URL
  if (!rpcUrl) fail('ARC_MAINNET_RPC_URL is required for Arc Mainnet GatewayClient')
  try {
    const parsed = new URL(rpcUrl)
    if (parsed.protocol !== 'https:') fail('ARC_MAINNET_RPC_URL must use HTTPS')
  } catch {
    fail('ARC_MAINNET_RPC_URL must be a valid HTTPS URL')
  }

  const buyer = privateKeyToAccount(buyerPrivateKey as `0x${string}`)
  console.log(`Buyer wallet: ${maskAddress(buyer.address)}`)
  console.log('Execution authorized by --execute; creating one Arc Mainnet authorization.')

  const gateway = new GatewayClient({
    chain: 'arc',
    privateKey: buyerPrivateKey as `0x${string}`,
    rpcUrl,
    arcPrivateMainnet: true,
  })

  const originalFetch = globalThis.fetch.bind(globalThis)
  let paidSubmissionCount = 0
  let captured: CapturedPaidRequest | null = null

  globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const requestUrl = input instanceof Request ? input.url : String(input)
    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
    const paymentSignature = headers.get('Payment-Signature')

    if (requestUrl === TARGET_URL && paymentSignature) {
      paidSubmissionCount += 1
      if (paidSubmissionCount > 1) {
        fail('Execution guard blocked an additional paid submission before the explicit replay phase')
      }
      if (typeof init?.body !== 'string') fail('Paid request body was not the expected serialized JSON')
      captured = {
        method: init.method ?? 'GET',
        body: init.body,
        paymentSignature,
        contentType: headers.get('Content-Type') ?? 'application/json',
      }
    }

    const response = await originalFetch(input, init)
    if (requestUrl === TARGET_URL && response.status === 402 && !paymentSignature) {
      const header = response.headers.get('PAYMENT-REQUIRED')
      if (!header) fail('GatewayClient preflight 402 is missing PAYMENT-REQUIRED')
      validatePaymentRequired(decodePaymentRequired(header), expectedAmount, expectedPayTo)
    }
    return response
  }

  let result: Awaited<ReturnType<GatewayClient['pay']>>
  try {
    result = await gateway.pay(TARGET_URL, {
      method: 'POST',
      body: JSON.parse(REQUEST_BODY) as Record<string, string>,
    })
  } finally {
    globalThis.fetch = originalFetch
  }

  const paidRequest = captured as CapturedPaidRequest | null
  if (paidSubmissionCount !== 1 || !paidRequest) {
    fail(`Expected exactly one paid submission; observed ${paidSubmissionCount}`)
  }
  if (result.amount !== expectedAmount) {
    fail('GatewayClient reported a payment amount different from the preflight amount')
  }
  if (result.status < 200 || result.status >= 300) {
    fail(`First paid request did not succeed: HTTP ${result.status}`)
  }

  console.log(`First paid request: HTTP ${result.status}; amount 0.001100 USDC; PASS`)
  console.log('Authorization and signature were captured in memory only and were not printed.')

  if (!replayOnce) {
    console.log('Replay: skipped (add --replay-once to reuse the same authorization exactly once).')
    return
  }

  console.log('Replay: submitting the identical authorization exactly once.')
  const replayResponse = await originalFetch(TARGET_URL, {
    method: paidRequest.method,
    headers: {
      'Content-Type': paidRequest.contentType,
      'Payment-Signature': paidRequest.paymentSignature,
    },
    body: paidRequest.body,
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  })

  await replayResponse.body?.cancel().catch(() => undefined)
  if (replayResponse.status >= 200 && replayResponse.status < 300) {
    fail(
      `TEST FAILURE: replay returned HTTP ${replayResponse.status}; a second charge/purchase may have occurred`,
    )
  }
  if (replayResponse.status !== 402) {
    fail(`TEST INCONCLUSIVE: replay returned HTTP ${replayResponse.status}, expected HTTP 402`)
  }

  console.log('Replay: HTTP 402; rejected before proxy/accounting success; PASS')
  console.log('Replay did not create a second successful paid request.')
}

async function main(): Promise<void> {
  const execute = process.argv.includes('--execute')
  const replayOnce = process.argv.includes('--replay-once')
  const requestedUrl = flagValue('--url') ?? TARGET_URL
  const expectedAmountArg = flagValue('--expected-amount-atomic')

  if (requestedUrl !== TARGET_URL) fail(`This harness is pinned to ${TARGET_URL}`)
  if (!expectedAmountArg || !/^\d+$/.test(expectedAmountArg)) {
    fail('--expected-amount-atomic is required and must be an integer')
  }

  const expectedAmount = BigInt(expectedAmountArg)
  if (expectedAmount !== REQUIRED_AMOUNT_ATOMIC) {
    fail(`This harness is pinned to ${REQUIRED_AMOUNT_ATOMIC.toString()} atomic USDC`)
  }
  if (replayOnce && !execute) {
    fail('--replay-once is only valid together with --execute')
  }

  const expectedPayTo = process.env.PLATFORM_WALLET_ADDRESS
  if (!expectedPayTo || !isAddress(expectedPayTo)) {
    fail('PLATFORM_WALLET_ADDRESS must be set to the expected production payment recipient')
  }

  console.log('Mahshar Arc Mainnet x402 verification harness')
  console.log(`Mode: ${execute ? 'EXECUTE (REAL FUNDS)' : 'PREFLIGHT ONLY (NO SIGNING OR PAYMENT)'}`)
  console.log(`Expected payment recipient: ${maskAddress(expectedPayTo)}`)
  printSideEffects()

  const selected = await fetchPreflight(expectedAmount, expectedPayTo)
  console.log('Preflight checks: PASS')
  console.log(`- selected network: ${selected.network}`)
  console.log(`- selected amount: ${selected.amount} atomic USDC (0.001100 USDC)`)
  console.log(`- payment recipient: ${maskAddress(selected.payTo!)}`)
  console.log(`- verifying contract: ${maskAddress(selected.extra!.verifyingContract!)}`)
  console.log('- scheme: exact / GatewayWalletBatched v1 / x402 v2')
  console.log('- Only Arc Mainnet was advertised')

  if (!execute) {
    console.log('\nExecution guard: --execute not present; exiting before key access, signing, or payment.')
    return
  }

  await executePayment(expectedAmount, expectedPayTo, replayOnce)
}

main().catch(error => {
  console.error(`FAILED: ${safeError(error)}`)
  process.exitCode = 1
})
