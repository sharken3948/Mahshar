import { promises as dns } from 'dns'

// DNS rebinding limitation: the hostname is resolved once here for validation, but the
// actual fetch() in the proxy/verify routes performs its own separate DNS resolution.
// A malicious DNS server could return a safe public IP during validation and switch to a
// private IP for the real request (DNS rebinding). Mitigating this fully would require
// binding the resolved IP directly in the fetch call. Accepted as a known limitation for
// the current scope.
export async function validateEndpointUrl(url: string): Promise<{ valid: boolean; error?: string }> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { valid: false, error: 'Invalid URL format' }
  }

  if (parsed.protocol !== 'https:') {
    return { valid: false, error: 'Only HTTPS endpoints are allowed' }
  }

  const hostname = parsed.hostname

  if (hostname === 'localhost' || hostname === '0.0.0.0' || hostname === '::1') {
    return { valid: false, error: 'Localhost addresses are not allowed' }
  }

  try {
    const { address } = await dns.lookup(hostname)
    if (isPrivateOrReservedIp(address)) {
      return { valid: false, error: 'Endpoint resolves to a private or reserved IP address' }
    }
  } catch {
    return { valid: false, error: 'Could not resolve hostname' }
  }

  return { valid: true }
}

function isPrivateOrReservedIp(ip: string): boolean {
  if (ip.includes(':')) {
    // IPv6 — conservatively block loopback and unique local addresses
    if (ip === '::1') return true
    if (ip.toLowerCase().startsWith('fc') || ip.toLowerCase().startsWith('fd')) return true
    return false
  }
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some(isNaN)) return true
  const [a, b] = parts
  if (a === 127) return true
  if (a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  if (a === 0) return true
  if (a >= 224 && a <= 239) return true  // multicast 224.0.0.0/4
  if (a === 255) return true              // broadcast 255.255.255.255
  return false
}
