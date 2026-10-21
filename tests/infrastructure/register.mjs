import Module from 'node:module'
import { fileURLToPath } from 'node:url'
const load = Module._load
Module._load = function(specifier, parent, isMain) {
  if (specifier === 'server-only') return {}
  if (specifier === '@/lib/supabase/server') return load.call(this,
    fileURLToPath(new URL('./database.ts', import.meta.url)), parent, isMain)
  return load.call(this, specifier, parent, isMain)
}
// Every provider call must be replaced explicitly. An accidental real call fails locally.
globalThis.fetch = async () => { throw new Error('NETWORK_FORBIDDEN_IN_PROTECTION_TESTS') }
process.env.GROQ_API_KEY = 'offline-fixture-key'
