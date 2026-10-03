import 'server-only'
import Groq from 'groq-sdk'

const groqKey = process.env.GROQ_API_KEY?.trim()

export const groq = new Groq({
  apiKey: groqKey || 'groq-not-configured',
  timeout: 8_000,
  maxRetries: 0,
})

export class GroqUnavailableError extends Error {
  constructor(message = 'AI suggestions are temporarily unavailable.') {
    super(message)
    this.name = 'GroqUnavailableError'
  }
}

export function ensureGroqAvailable(): void {
  if (!process.env.GROQ_API_KEY?.trim()) throw new GroqUnavailableError()
}

export const GROQ_MODEL = process.env.GROQ_MODEL?.trim() || 'openai/gpt-oss-120b'

export const UNTRUSTED_OPEN = '<<<BEGIN_UNTRUSTED_INPUT_9f2c7a>>>'
export const UNTRUSTED_CLOSE = '<<<END_UNTRUSTED_INPUT_9f2c7a>>>'
const SENTINEL_LIKE = /<<<[^>]*UNTRUSTED[^>]*>>>/gi

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/(authorization\s*[:=]\s*)(bearer\s+|basic\s+|token\s+)?[A-Za-z0-9._~+/=-]{16,}/gi, '$1$2[redacted]'],
  [/("(?:authorization|proxy[-_]authorization|api[_-]?key|apikey|access[_-]?token|token|secret|password|auth[_-]?token|x-api-key)"\s*:\s*)"[^"]{4,}"/gi, '$1"[redacted]"'],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, 'bearer [redacted]'],
  [/\b(?:sk|rk|pk)_(?:live|test|prod)_[A-Za-z0-9]{16,}/g, '[redacted-key]'],
  [/\bsk-[A-Za-z0-9._~+/=-]{16,}/g, '[redacted-key]'],
  [/\bxox[bpsa]-[A-Za-z0-9-]{10,}/g, '[redacted-slack]'],
  [/\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[redacted-jwt]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted-aws]'],
]

export function redactSecrets(input: string): string {
  if (typeof input !== 'string' || input.length === 0) return input
  let output = input
  for (const [pattern, replacement] of SECRET_PATTERNS) output = output.replace(pattern, replacement)
  return output
}

export function redactUrlSecrets(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0) return raw
  try {
    const url = new URL(raw)
    url.search = ''
    url.hash = ''
    if (url.username || url.password) {
      url.username = ''
      url.password = ''
    }
    return redactSecrets(url.toString())
  } catch {
    return redactSecrets(raw)
  }
}

function sanitizeFenced(value: string): string {
  return value.replace(SENTINEL_LIKE, '<<<sanitized-marker>>>')
}

export function fenceUntrusted(label: string, value: string): string {
  return `${UNTRUSTED_OPEN} ${label}\n${sanitizeFenced(value)}\n${UNTRUSTED_CLOSE}`
}

export function safePromptField(value: unknown, maxLen: number): string {
  if (value === null || value === undefined) return '(not provided)'
  const raw = typeof value === 'string' ? value : JSON.stringify(value)
  const redacted = redactSecrets(raw)
  return redacted.length > maxLen ? `${redacted.slice(0, maxLen)}…` : redacted
}
