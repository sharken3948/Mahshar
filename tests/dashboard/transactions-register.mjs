import Module, { register } from 'node:module'
import React from 'react'
import { fileURLToPath } from 'node:url'

const load = Module._load
register('../marketplace/loader.mjs', import.meta.url)
const fixtures = fileURLToPath(new URL('../marketplace/fixtures.ts', import.meta.url))
Module._load = function(specifier, parent, isMain) {
  if (specifier === 'server-only') return {}
  if (specifier === '@/lib/supabase/server') return load.call(this, fixtures, parent, isMain)
  if (specifier.endsWith('.module.css')) return new Proxy({}, { get: (_, key) => key === '__esModule' ? false : String(key) })
  if (specifier === '@rainbow-me/rainbowkit') return { ConnectButton: () => React.createElement('button', null, 'Connect wallet') }
  if (specifier === 'next/link') return { __esModule: true, default: ({ href, children, ...props }) => React.createElement('a', { href, ...props }, children) }
  if (specifier === '../dashboard-visuals') return { DashboardIcon: () => React.createElement('svg', { 'aria-hidden': true }) }
  if (specifier === '../dashboard-workspace') return { useDashboardWorkspace: () => ({ address: null, isConnected: false }) }
  if (specifier === '@/components/MarketplaceSessionProvider') return { useMarketplaceSession: () => ({ status: 'unauthenticated', wallet: null, request: fetch, authenticate: async () => false, error: null }) }
  return load.call(this, specifier, parent, isMain)
}

process.env.MARKETPLACE_ORIGIN = 'https://mahshar.xyz'
