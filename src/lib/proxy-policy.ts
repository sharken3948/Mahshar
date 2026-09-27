const SUPPORTED_PROXY_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE']);

export type ProxyMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export function resolveListingProxyMethod(
  callerMethod: unknown,
  configuredMethod: unknown,
): { method: ProxyMethod } | { error: string } {
  const configured = typeof configuredMethod === 'string' && configuredMethod.length > 0
    ? configuredMethod.toUpperCase()
    : 'GET';

  if (!SUPPORTED_PROXY_METHODS.has(configured)) {
    return { error: 'Listing HTTP method is unsupported' };
  }

  if (callerMethod !== undefined) {
    if (typeof callerMethod !== 'string' || !SUPPORTED_PROXY_METHODS.has(callerMethod.toUpperCase())) {
      return { error: 'Caller HTTP method is unsupported' };
    }
    if (callerMethod.toUpperCase() !== configured) {
      return { error: 'Caller HTTP method does not match listing method' };
    }
  }

  return { method: configured as ProxyMethod };
}
