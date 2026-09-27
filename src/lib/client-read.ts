'use client'

export interface JsonReadResult<T> {
  ok: boolean
  status: number
  data: T
}

const inFlight = new Map<string, Promise<JsonReadResult<unknown>>>()

/** Coalesces only identical in-flight same-origin GETs; completed reads are never cached. */
export function coalescedJsonGet<T>(url: string, fetcher: typeof fetch = fetch): Promise<JsonReadResult<T>> {
  if (!url.startsWith('/api/') || url.startsWith('//')) throw new Error('Invalid Mahshar read')
  const existing = inFlight.get(url)
  if (existing) return existing as Promise<JsonReadResult<T>>

  const request = fetcher(url, { cache: 'no-store', credentials: 'same-origin' }).then(async response => ({
    ok: response.ok,
    status: response.status,
    data: await response.json() as T,
  }))
  inFlight.set(url, request as Promise<JsonReadResult<unknown>>)
  const clear = () => { if (inFlight.get(url) === request) inFlight.delete(url) }
  void request.then(clear, clear)
  return request
}
