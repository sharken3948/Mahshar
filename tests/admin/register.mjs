import Module from 'node:module'
import { fileURLToPath } from 'node:url'
const fixture = fileURLToPath(new URL('./fixture.ts', import.meta.url))
const load = Module._load
Module._load = function(specifier, parent, isMain) {
  if (specifier.endsWith('.module.css')) return new Proxy({}, { get: (_, key) => key === '__esModule' ? false : String(key) })
  if (specifier === 'server-only') return {}
  if (['@/lib/supabase/server', '@/lib/crawler', '@/lib/discovery', '@/lib/outbound-fetch', '@/lib/proxy'].includes(specifier)) return load.call(this, fixture, parent, isMain)
  if (specifier === 'next/server') return load.call(this, fileURLToPath(new URL('../marketplace/next.ts', import.meta.url)), parent, isMain)
  return load.call(this, specifier, parent, isMain)
}
process.env.MARKETPLACE_ORIGIN = 'https://mahshar.xyz'
globalThis.fetch = async () => { throw new Error('Network forbidden in admin tests') }
process.env.ENCRYPTION_KEY = 'ab'.repeat(32) // Synthetic fixture only; public listing module validates configuration on import.
