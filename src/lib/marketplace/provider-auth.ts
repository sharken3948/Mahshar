import 'server-only'
import type { AuthType } from '@/types'
import { buildUpstreamAuthentication } from './upstream-auth'

export async function providerAuthentication(input: { target: URL; type: AuthType; credential?: string; param?: string | null }) {
  return buildUpstreamAuthentication(input.target, input.type, input.credential, input.param)
}

/** Inspect raw and parsed response strings/keys, including URL, JSON and Base64 representations. */
export function reflectsProviderSecret(raw: string, parsed: unknown, secrets: string[]) {
  const variants = new Set<string>()
  // HTTP header processing removes surrounding whitespace. Inspect that wire
  // representation too, without changing any legacy credential's stored value.
  const normalizedSecrets = [...new Set(secrets.flatMap(value => [value, value.trim()]).filter(Boolean))]
  for (const secret of normalizedSecrets) {
    variants.add(secret)
    variants.add(JSON.stringify(secret).slice(1, -1))
    variants.add(Buffer.from(secret).toString('base64'))
    variants.add(encodeURIComponent(secret))
    variants.add(new URLSearchParams([['x', secret]]).toString().slice(2))
  }
  const values = [...variants].flatMap(value => [value, value.replace(/%[0-9A-F]{2}/g, match => match.toLowerCase())])
  if (values.some(value => raw.includes(value))) return true
  const pending: unknown[] = [parsed]
  while (pending.length) {
    const value = pending.pop()
    if (typeof value === 'string' && values.some(secret => value.includes(secret))) return true
    if (value && typeof value === 'object') for (const [key, nested] of Object.entries(value)) {
      if (values.some(secret => key.includes(secret))) return true
      pending.push(nested)
    }
  }
  return false
}
