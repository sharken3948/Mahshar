import Module from 'node:module'
import { fileURLToPath } from 'node:url'
const fixture = fileURLToPath(new URL('./integration-fixture.ts', import.meta.url))
const next = fileURLToPath(new URL('../marketplace/next.ts', import.meta.url))
const mocks = new Set(['@circle-fin/x402-batching/server','@circle-fin/x402-batching/client','@circle-fin/app-kit','@circle-fin/adapter-viem-v2','@/lib/payments/server','@/lib/supabase/server','@/lib/proxy','@/lib/memo','@/lib/marketplace/server'])
const load = Module._load
Module._load = function(specifier, parent, isMain) {
  if (specifier === 'server-only') return {}
  if (specifier === 'viem') return { defineChain: c => c, createPublicClient: () => { throw Error('RPC forbidden in settlement tests') }, createWalletClient: () => { throw Error('Wallet forbidden in settlement tests') }, http: () => { throw Error('RPC forbidden in settlement tests') } }
  return load.call(this, mocks.has(specifier) ? fixture : specifier === 'next/server' ? next : specifier, parent, isMain)
}
// Synthetic fixture key only. No SDK client is allowed to make financial calls.
process.env.PLATFORM_WALLET_ADDRESS = '0x' + '44'.repeat(20)
process.env.PLATFORM_WALLET_PRIVATE_KEY = '0x' + 'ab'.repeat(32)
process.env.ENCRYPTION_KEY = 'ab'.repeat(32)
process.env.MARKETPLACE_ORIGIN = 'https://mahshar.xyz'
