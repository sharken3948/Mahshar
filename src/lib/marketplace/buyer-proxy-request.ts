import { resolveListingProxyMethod, type ProxyMethod } from '@/lib/proxy-policy'
import { declaredParameters, validateDeclaredParameterValue } from './proxy-target'

export interface BuyerProxyEnvelope {
  api_id: string
  buyer_wallet: string
  method: ProxyMethod
  path?: string
  body?: unknown
}

export type BuyerRequestValues = { path: Record<string, string>; query: Record<string, string> }

export function buildBuyerRequestSuffix(pathMetadata: unknown, queryMetadata: unknown, values: BuyerRequestValues): string {
  const pathParameters = declaredParameters(pathMetadata)
  const queryParameters = declaredParameters(queryMetadata)
  const pathNames = new Set(pathParameters.map(parameter => parameter.name))
  const queryNames = new Set(queryParameters.map(parameter => parameter.name))
  if (Object.keys(values.path).some(name => !pathNames.has(name)) || Object.keys(values.query).some(name => !queryNames.has(name))) {
    throw new Error('Request includes an undeclared input')
  }
  const segments: string[] = []
  let optionalGap = false
  for (const parameter of pathParameters) {
    const value = values.path[parameter.name]?.trim()
    if (!value) {
      if (parameter.required === true) throw new Error(`Path input "${parameter.name}" is required`)
      optionalGap = true
      continue
    }
    if (optionalGap) throw new Error(`Path input "${parameter.name}" cannot follow an empty optional segment`)
    if (!validateDeclaredParameterValue(value, parameter)) throw new Error(`Path input "${parameter.name}" is invalid`)
    segments.push(encodeURIComponent(value))
  }
  const query = new URLSearchParams()
  for (const parameter of queryParameters) {
    const value = values.query[parameter.name]?.trim()
    if (!value) {
      if (parameter.required === true) throw new Error(`Query input "${parameter.name}" is required`)
      continue
    }
    if (!validateDeclaredParameterValue(value, parameter)) throw new Error(`Query input "${parameter.name}" is invalid`)
    query.append(parameter.name, value)
  }
  query.sort()
  const search = query.toString()
  return `${segments.length ? `/${segments.join('/')}` : ''}${search ? `?${search}` : ''}`
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
  path?: string,
): BuyerProxyEnvelope {
  return {
    api_id: apiId,
    buyer_wallet: buyerWallet,
    method: configuredBuyerMethod(method),
    ...(path ? { path } : {}),
    ...(body !== undefined ? { body } : {}),
  }
}
