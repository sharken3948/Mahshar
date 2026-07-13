import { config } from 'dotenv'
import { resolve } from 'path'
import { GatewayClient } from '@circle-fin/x402-batching/client'

config({ path: resolve(process.cwd(), '.env.local') })

const privateKey = process.env.BUYER_PRIVATE_KEY as `0x${string}`
if (!privateKey) {
  console.error('Set BUYER_PRIVATE_KEY in .env.local to test this script')
  process.exit(1)
}

const gateway = new GatewayClient({
  chain: 'arcTestnet',
  privateKey,
})

console.log('Wallet:', gateway.address)
console.log('Calling Mahshar ioscope API 1 time...\n')

const IOSCOPE_API_ID = '34c7a931-81de-4b8b-81ac-0916b4316989'

for (let i = 1; i <= 1; i++) {
  const start = Date.now()
  try {
    const { data } = await gateway.pay('https://mahshar.xyz/api/proxy', {
      method: 'POST',
      body: {
        api_id: IOSCOPE_API_ID,
        buyer_wallet: gateway.address,
        method: 'POST',
        body: { address: '0x1234567890123456789012345678901234567890', chain: 'arc' },
      },
    })
    const ms = Date.now() - start
    const d = data as { response?: { riskScore?: number } }
    console.log(`#${i} success (${ms}ms) — riskScore: ${d?.response?.riskScore ?? 'n/a'}`)
  } catch (err) {
    console.error(`#${i} FAILED:`, (err as Error).message)
  }
  await new Promise(r => setTimeout(r, 3500))
}

console.log('\nDone.')
