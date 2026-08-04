import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { privateKeyToAccount } from 'viem/accounts'
import type { Hex } from 'viem'

const envPath = resolve(process.cwd(), '.env.local')
if (!existsSync(envPath)) {
  console.error(`no .env.local at ${envPath}`)
  process.exit(1)
}
const env = readFileSync(envPath, 'utf8')
const pkMatch =
  env.match(/^PLATFORM_WALLET_PK\s*=\s*(.+)$/m) ??
  env.match(/^PLATFORM_WALLET_PRIVATE_KEY\s*=\s*(.+)$/m)
if (!pkMatch) {
  console.error('neither PLATFORM_WALLET_PK nor PLATFORM_WALLET_PRIVATE_KEY present in .env.local')
  process.exit(1)
}
const pk = pkMatch[1].trim().replace(/^["']|["']$/g, '') as Hex
if (!/^0x[a-fA-F0-9]{64}$/.test(pk)) {
  console.error('PLATFORM_WALLET_PK is malformed (expected 0x + 64 hex chars)')
  process.exit(1)
}

const address = privateKeyToAccount(pk).address
console.log(`address: ${address}`)

const res = await fetch('https://gateway-api-testnet.circle.com/v1/balances', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    token: 'USDC',
    sources: [{ depositor: address, domain: 26 }],
  }),
})
console.log(`http status: ${res.status}`)
const body = await res.json()
console.log(JSON.stringify(body, null, 2))
