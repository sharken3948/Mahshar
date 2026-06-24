import { promises as dns } from 'dns'

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
    // H2: block all known private/reserved IPv6 ranges
    const lower = ip.toLowerCase()
    if (lower === '::1') return true                                        // loopback
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true      // unique local (fc00::/7)
    if (lower.startsWith('fe80')) return true                              // link-local (fe80::/10)
    if (lower.startsWith('::ffff:')) return true                           // IPv4-mapped (::ffff:0:0/96)
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
