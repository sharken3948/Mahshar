import 'server-only'

type CacheEntry<T> = {
  value?: T
  expiresAt: number
  pending?: Promise<T>
}

const cache = new Map<string, CacheEntry<unknown>>()

/**
 * Small process-local cache for low-value operational reads. It avoids adding a
 * cache service dependency and never bypasses route authorization: callers run
 * this only after withAdmin has authenticated the request.
 */
export function withOperationsTtl<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const now = Date.now()
  const current = cache.get(key) as CacheEntry<T> | undefined
  if (current?.value !== undefined && current.expiresAt > now) return Promise.resolve(current.value)
  if (current?.pending) return current.pending

  const pending = load().then(value => {
    cache.set(key, { value, expiresAt: Date.now() + ttlMs })
    return value
  }).catch(error => {
    if (current?.value !== undefined) cache.set(key, { value: current.value, expiresAt: current.expiresAt })
    else cache.delete(key)
    throw error
  })
  cache.set(key, { value: current?.value, expiresAt: current?.expiresAt ?? 0, pending })
  return pending
}

export function clearOperationsCacheForTests() {
  cache.clear()
}
