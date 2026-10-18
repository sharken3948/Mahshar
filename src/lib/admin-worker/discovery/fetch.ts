import 'server-only'
import { safeOutboundFetch } from '@/lib/outbound-fetch'
import { WORKER_EXTERNAL_RESPONSE_LIMIT, WORKER_EXTERNAL_TIMEOUT_MS } from '../constants'

export type DiscoveryFetcher = (url: string, options?: { maxBytes?: number; accept?: string; timeoutMs?: number; beforeRequest?: (url?: string) => Promise<void>; validateUrl?: (url: string) => boolean }) => Promise<{
  url: string
  status: number
  contentType: string
  retryAfter?: string | null
  body: string
}>

export class DiscoveryResponseTooLargeError extends Error {
  constructor() { super('discovery_response_too_large') }
}

export type DiscoveryTransport = (url: string, init: RequestInit, timeoutMs: number) => Promise<Response>

const defaultTransport: DiscoveryTransport = (url, init, timeoutMs) => safeOutboundFetch(url, init, { timeoutMs })

export async function boundedDiscoveryFetch(
  input: string,
  options: { maxBytes?: number; accept?: string; timeoutMs?: number; beforeRequest?: (url?: string) => Promise<void>; validateUrl?: (url: string) => boolean } = {},
  transport: DiscoveryTransport = defaultTransport,
): Promise<{ url: string; status: number; contentType: string; body: string; retryAfter?: string | null }> {
  const maxBytes = Math.min(options.maxBytes ?? WORKER_EXTERNAL_RESPONSE_LIMIT, WORKER_EXTERNAL_RESPONSE_LIMIT)
  const timeoutMs = Math.min(options.timeoutMs ?? WORKER_EXTERNAL_TIMEOUT_MS, WORKER_EXTERNAL_TIMEOUT_MS)
  let current = input
  for (let redirects = 0; redirects <= 2; redirects += 1) {
    if (options.validateUrl && !options.validateUrl(current)) throw new Error('discovery_reference_not_authorized')
    await options.beforeRequest?.(current)
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let response: Response
    try {
      response = await Promise.race([
        transport(current, {
          method: 'GET', redirect: 'manual', signal: controller.signal, headers: {
            accept: options.accept ?? 'application/json, text/html;q=0.8, text/plain;q=0.5',
            'accept-encoding': 'identity',
            'user-agent': 'Mahshar-Discovery/1.0',
          },
        }, timeoutMs),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort(new Error('discovery_timeout'))
            reject(new Error('discovery_timeout'))
          }, timeoutMs)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      if (!location || redirects === 2) throw new Error('discovery_redirect_invalid')
      await response.body?.cancel()
      current = new URL(location, current).toString()
      continue
    }
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel()
      throw new DiscoveryResponseTooLargeError()
    }
    const reader = response.body?.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    if (reader) {
      while (true) {
        const part = await reader.read()
        if (part.done) break
        size += part.value.byteLength
        if (size > maxBytes) { await reader.cancel(); throw new DiscoveryResponseTooLargeError() }
        chunks.push(part.value)
      }
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return {
      url: current,
      status: response.status,
      contentType: response.headers.get('content-type')?.slice(0, 120) ?? '',
      retryAfter: response.headers.get('retry-after')?.slice(0, 128) ?? null,
      body: new TextDecoder().decode(bytes),
    }
  }
  throw new Error('discovery_redirect_invalid')
}

export async function boundedJson<T>(fetcher: DiscoveryFetcher, url: string, maxBytes = WORKER_EXTERNAL_RESPONSE_LIMIT): Promise<T> {
  const response = await fetcher(url, { maxBytes, accept: 'application/json' })
  if (response.status < 200 || response.status >= 300) throw new Error('discovery_source_http_error')
  if (!response.contentType.toLowerCase().includes('json')) throw new Error('discovery_source_content_type')
  try { return JSON.parse(response.body) as T }
  catch { throw new Error('discovery_source_malformed') }
}
