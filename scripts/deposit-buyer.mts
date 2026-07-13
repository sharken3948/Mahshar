import { config } from 'dotenv'
import { resolve } from 'path'
import { GatewayClient } from '@circle-fin/x402-batching/client'

config({ path: resolve(process.cwd(), '.env.local') })

const privateKey = process.env.BUYER_PRIVATE_KEY as `0x${string}`
if (!privateKey) {
  console.error('BUYER_PRIVATE_KEY not set in .env.local')
  process.exit(1)
}

const gateway = new GatewayClient({ chain: 'arcTestnet', privateKey })

console.log('Buyer wallet:', gateway.address)
console.log('Depositing 1 USDC into Circle Gateway (Arc Testnet)...')

const result = await gateway.deposit('1')
console.log('Deposit result:', result)
