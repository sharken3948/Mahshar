const Module = require('node:module')
const path = require('node:path')
const original = Module._load
Module._load = function(specifier, parent, main) {
  if (specifier === '@/lib/free-api-worker/runtime' && parent?.filename?.includes('/workflows/')) {
    const actual = original.call(this, specifier, parent, main)
    return { ...actual, workerStep: generation => {
      const { boundary } = original.call(this, path.join(__dirname, 'postgres-adapter.ts'), parent, main)
      return boundary.runStep ? boundary.runStep(generation) : actual.workerStep(generation)
    } }
  }
  if (specifier === 'workflow') return { sleep: async date => { const { boundary } = original.call(this, path.join(__dirname, 'postgres-adapter.ts'), parent, main); if (boundary.sleep) return boundary.sleep(date); throw new Error('Idle workflow sleep is not executed in isolated fixtures') } }
  if (specifier === 'server-only') return {}
  if (specifier.endsWith('.module.css')) return {}
  if (specifier === '@/lib/supabase/server' || specifier === 'workflow/api') return original.call(this, path.join(__dirname, 'postgres-adapter.ts'), parent, main)
  if (specifier === '@/components/MarketplaceSessionProvider') return { useMarketplaceSession: () => ({ request: async () => { throw new Error('Render cannot send requests') } }) }
  if (specifier === 'wagmi') return { useAccount: () => ({}) }
  if (specifier === 'next/server') return original.call(this, path.join(__dirname, '../marketplace/next.ts'), parent, main)
  return original.call(this, specifier, parent, main)
}
process.env.MARKETPLACE_ORIGIN = 'https://mahshar.xyz'
process.env.ENCRYPTION_KEY = 'ab'.repeat(32)
globalThis.fetch = async () => { throw new Error('Network forbidden in isolated integration') }
