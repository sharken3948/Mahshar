import { resolveListingProxyMethod, type ProxyMethod } from '@/lib/proxy-policy'

export interface BuyerProxyEnvelope {
  api_id: string
  buyer_wallet: string
  method: ProxyMethod
  body?: unknown
}

export function configuredBuyerMethod(method: unknown): ProxyMethod {
  const resolved = resolveListingProxyMethod(undefined, method)
  if ('error' in resolved) throw new Error(resolved.error)
  return resolved.method
}

export function exampleRequestHasForwardableBody(method: unknown, exampleRequest: string | null | undefined): boolean {
  if (configuredBuyerMethod(method) === 'GET' || !exampleRequest?.trim()) return false
  try {
    return Boolean(JSON.parse(exampleRequest))
  } catch {
    return false
  }
}

export function buildBuyerProxyEnvelope(
  apiId: string,
  buyerWallet: string,
  method: unknown,
  body?: unknown,
): BuyerProxyEnvelope {
  return {
    api_id: apiId,
    buyer_wallet: buyerWallet,
    method: configuredBuyerMethod(method),
    ...(body !== undefined ? { body } : {}),
  }
}
