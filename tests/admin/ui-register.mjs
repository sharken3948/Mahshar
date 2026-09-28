import Module from 'node:module'
const load = Module._load
Module._load = function(specifier, parent, isMain) {
  if (specifier === '@/components/MarketplaceSessionProvider') return { useMarketplaceSession: () => ({ request() { throw new Error('Unexpected request') }, status: 'authenticated', authenticate: async () => true, error: null, wallet: null }) }
  return load.call(this, specifier, parent, isMain)
}
