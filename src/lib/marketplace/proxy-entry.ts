import { resolveListingProxyMethod, type ProxyMethod } from '@/lib/proxy-policy'

export interface ListingProxyEntry {
  method: ProxyMethod
  proxy_url: string
  proxy_style: 'path' | 'envelope'
}

export function listingProxyEntry(apiId: string, configuredMethod: unknown, appUrl = 'https://mahshar.xyz', dynamicPath = false): ListingProxyEntry {
  const resolved = resolveListingProxyMethod(undefined, configuredMethod)
  if ('error' in resolved) throw new Error(resolved.error)
  const pathRouteSupported = !dynamicPath && (resolved.method === 'GET' || resolved.method === 'POST')
  return {
    method: resolved.method,
    proxy_url: pathRouteSupported ? `${appUrl}/api/proxy/${apiId}` : `${appUrl}/api/proxy`,
    proxy_style: pathRouteSupported ? 'path' : 'envelope',
  }
}
