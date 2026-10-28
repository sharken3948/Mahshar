// Browser-safe types and progress; no credentials or server dependencies.
export type BulkProgress = {
  id: string; mode: 'FREE' | 'PAID'; price: number | string; authorized_at: string; retry_at: string | null;
  items: { candidate_id: string; name: string; ordinal: number; status: 'pending' | 'processing' | 'published' | 'failed';
    stage: string; listing_id: string | null; last_error: string | null; lease_until: string | null; attempts: number; updated_at?: string }[]
}
// A slow status read must not replace a newer checkpoint from the POST response.
export function mergeBulkProgress(previous: BulkProgress | null, incoming: BulkProgress | null): BulkProgress | null {
  if (!previous || !incoming || previous.id !== incoming.id) return incoming
  return { ...incoming, items: incoming.items.map(item => {
    const prior = previous.items.find(row => row.candidate_id === item.candidate_id)
    return prior && Date.parse(prior.updated_at ?? '') > Date.parse(item.updated_at ?? '') ? prior : item
  }) }
}
export function bulkCounts(batch: BulkProgress, now = Date.now()) {
  const counts = { published: 0, failed: 0, processing: 0, remaining: 0 }
  for (const item of batch.items) {
    if (item.status === 'published') counts.published++
    else if (item.status === 'failed') counts.failed++
    else if (item.status === 'processing' && Date.parse(item.lease_until ?? '') > now) counts.processing++
    else counts.remaining++
  }
  return counts
}

/** Only an explicit confirm/resume invokes this loop. Reloads only read saved state. */
export async function runBulkSelection(options: {
  batch: BulkProgress; request: (url: string, init?: RequestInit) => Promise<Response>;
  stopped: () => boolean; onProgress: (batch: BulkProgress) => void; wait: (ms: number) => Promise<void>
}) {
  async function requestBatch(path: string, init: RequestInit, timeout: number) {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        (async () => {
          const response = await options.request(path, { ...init, signal: controller.signal })
          const body = await response.json()
          if (!response.ok || !body.batch) throw Object.assign(new Error(body.error ?? 'Publication paused. Resume reconciles saved progress.'), { status: response.status })
          return body.batch as BulkProgress
        })(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Bulk request interrupted')) }, timeout) }),
      ])
    } finally { clearTimeout(timer) }
  }
  let batch = options.batch
  while (!options.stopped()) {
    const counts = bulkCounts(batch)
    if (!counts.remaining && !counts.processing) return batch
    if (batch.retry_at && Date.parse(batch.retry_at) > Date.now()) {
      await options.wait(Math.min(Date.parse(batch.retry_at) - Date.now(), 5000))
      continue
    }
    const path = `/api/admin/free-api-worker/batches/${batch.id}`
    try {
      batch = await requestBatch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'next' }) }, 75_000)
    } catch (error) {
      const status = (error as { status?: number }).status
      if (options.stopped() || status && status < 500) throw error
      const saved = await requestBatch(path, { cache: 'no-store' }, 10_000)
      // A lost response can conceal a completed write. Reconcile before sending another next request.
      if (!saved.items.some(item => item.status === 'processing') && JSON.stringify(saved) === JSON.stringify(batch)) throw error
      batch = saved
    }
    options.onProgress(batch)
    // A second tab may own the current request; do not hammer it or steal its lease.
    if (bulkCounts(batch).processing) await options.wait(5000)
  }
  return batch
}
