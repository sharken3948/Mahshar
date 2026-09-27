import Module, { register } from 'node:module'
import { fileURLToPath } from 'node:url'
register('./loader.mjs', import.meta.url)
// tsx follows this repository's CommonJS package mode for .ts modules.
// Intercept only the same explicit external boundaries used by the ESM loader.
const replacements = new Map([
  ['@/lib/supabase/server', './fixtures.ts'], ['@/lib/groq', './stubs.ts'],
  ['@/lib/gateway', './stubs.ts'], ['@/lib/memo', './stubs.ts'],
  ['@/lib/url-validation', './stubs.ts'], ['next/server', './next.ts'],
])
const load = Module._load
Module._load = function (specifier, parent, isMain) {
  if (specifier === 'server-only') return {}
  return load.call(this, replacements.has(specifier) ? fileURLToPath(new URL(replacements.get(specifier), import.meta.url)) : specifier, parent, isMain)
}
process.env.ENCRYPTION_KEY = 'ab'.repeat(32)
process.env.MARKETPLACE_ORIGIN = 'https://mahshar.xyz'
process.env.PLATFORM_WALLET_ADDRESS = '0x' + '44'.repeat(20)
