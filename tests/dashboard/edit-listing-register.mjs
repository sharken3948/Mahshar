import Module from 'node:module'
import React from 'react'

const load = Module._load
export const editListingState = globalThis.__mahsharEditListingState ??= { requests: [] }
export function resetEditListingState() { editListingState.requests = [] }

Module._load = function (id, parent, main) {
  if (id.endsWith('.module.css')) return new Proxy({}, { get: (_, key) => key === '__esModule' ? false : String(key) })
  if (id === 'wagmi') return { useAccount: () => ({ address: '0x' + '11'.repeat(20) }) }
  if (id === '@/components/MarketplaceSessionProvider') return { useMarketplaceSession: () => ({
    request: async (...args) => { editListingState.requests.push(args); return Response.json({}) },
    sensitiveRequest: async (...args) => { editListingState.requests.push(args); return Response.json({}) },
  }) }
  if (id === '@/components/RequestParameterEditor') return { RequestParameterEditor: ({ location }) => React.createElement('div', null, `${location} editor`) }
  return load.call(this, id, parent, main)
}
