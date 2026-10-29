import Module from 'node:module'
import { fileURLToPath } from 'node:url'

// Keep the real route, viem ABI/transport and rate limiter. Replace only the DB.
const load = Module._load
Module._load = function (id, parent, main) {
  if (id === 'server-only') return {}
  if (id === '@/lib/supabase/server') {
    return load.call(this, fileURLToPath(new URL('./database.ts', import.meta.url)), parent, main)
  }
  return load.call(this, id, parent, main)
}
