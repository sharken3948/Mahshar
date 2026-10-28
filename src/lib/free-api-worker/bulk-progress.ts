// Browser-safe types and progress; no credentials or server dependencies.
export type BulkProgress = {
  id: string; mode: 'FREE' | 'PAID'; price: number | string; authorized_at: string; retry_at: string | null;
  items: { candidate_id: string; name: string; ordinal: number; status: 'pending' | 'processing' | 'published' | 'failed';
    stage: string; listing_id: string | null; last_error: string | null; lease_until: string | null; attempts: number }[]
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
  let batch = options.batch
  while (!options.stopped()) {
    const counts = bulkCounts(batch)
    if (!counts.remaining && !counts.processing) return batch
    if (batch.retry_at && Date.parse(batch.retry_at) > Date.now()) {
      await options.wait(Math.min(Date.parse(batch.retry_at) - Date.now(), 5000))
      continue
    }
    const response = await options.request(`/api/admin/free-api-worker/batches/${batch.id}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'next' }),
    })
    const body = await response.json()
    if (!response.ok || !body.batch) throw new Error(body.error ?? 'Publication paused. Resume reconciles saved progress.')
    batch = body.batch
    options.onProgress(batch)
    // A second tab may own the current request; do not hammer it or steal its lease.
    if (bulkCounts(batch).processing) await options.wait(5000)
  }
  return batch
}
