import { isOutboundUrlShapeAllowed } from '@/lib/outbound-fetch'
import { redactSecrets } from '@/lib/groq-neutral'

export function canonicalExternalUrl(raw: string | undefined, maxLength = 2048): string | undefined {
  if (!raw) return undefined
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' || url.username || url.password) return undefined
    url.search = ''
    url.hash = ''
    if (url.port === '443') url.port = ''
    const redactedPath = redactSecrets(decodeURIComponent(url.pathname))
    if (redactedPath !== decodeURIComponent(url.pathname)) return undefined
    const canonical = url.toString()
    return canonical.length <= maxLength && isOutboundUrlShapeAllowed(canonical) ? canonical : undefined
  } catch {
    return undefined
  }
}

export function durableExternalName(raw: string | undefined, maxLength: number): string | undefined {
  if (!raw) return undefined
  const redacted = redactSecrets(raw)
    .replace(/\[(?:redacted(?:-[a-z]+)?|redacted)\]/gi, ' ')
    .replace(/\s+/g, ' ').replace(/^[\s:|/_.-]+|[\s:|/_.-]+$/g, '').trim()
  if (!redacted || redacted.length < 2 || /^(?:authorization|bearer|basic|token|api[ _-]?key)$/i.test(redacted)) return undefined
  return redacted.slice(0, maxLength)
}

export function durableExternalSummary(raw: string | undefined, maxLength: number): string | undefined {
  if (!raw) return undefined
  const value = redactSecrets(raw).replace(/\s+/g, ' ').trim()
  return value ? value.slice(0, maxLength) : undefined
}
