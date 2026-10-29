// Browser-safe types and progress; no credentials or server dependencies.
export type BulkProgress = {
  id: string; mode: 'FREE' | 'PAID'; price: number | string; authorized_at: string; retry_at: string | null;
  pause_reason?: 'groq_rate_limit' | null;
  items: { candidate_id: string; name: string; ordinal: number; status: 'pending' | 'processing' | 'published' | 'failed';
    stage: string; listing_id: string | null; last_error: string | null; lease_until: string | null; attempts: number; updated_at?: string;
    events?: { event: string; at: string }[] }[]
}
// A slow status read must not replace a newer checkpoint from the POST response.
export function mergeBulkProgress(previous: BulkProgress | null, incoming: BulkProgress | null): BulkProgress | null {
  if (!previous || !incoming || previous.id !== incoming.id) return incoming
  const latest = (batch: BulkProgress) => Math.max(...batch.items.map(item => Date.parse(item.updated_at ?? batch.authorized_at)))
  return { ...(latest(previous) > latest(incoming) ? previous : incoming), items: incoming.items.map(item => {
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

// Existing saved events survive reload/Resume; a Resume checkpoint is not a new attempt.
export function bulkPacingUntil(batch: BulkProgress): number {
  let finishedAt = 0
  for (const item of batch.items) {
    const endings = item.events?.filter(event => ['published', 'published_reconciled', 'failed', 'timeout', 'pending', 'groq_rate_limit'].includes(event.event))
    const times = endings?.length ? endings.map(event => event.at)
      : item.attempts > 0 && item.status !== 'processing' ? [item.updated_at ?? ''] : []
    // An abandoned attempt ends at its lease deadline, before the next POST reconciles it.
    if (item.status === 'processing' && item.lease_until) times.push(item.lease_until)
    for (const at of times) finishedAt = Math.max(finishedAt, Date.parse(at) || 0)
  }
  return finishedAt ? finishedAt + 10_000 : 0
}

/** Only an explicit confirm/resume invokes this loop. Reloads only read saved state. */
export async function runBulkSelection(options: {
  batch: BulkProgress; request: (url: string, init?: RequestInit) => Promise<Response>;
  stopped: () => boolean; onProgress: (batch: BulkProgress) => void; wait: (ms: number) => Promise<void>
  onNotice?: (message: string) => void
}) {
  async function requestBatch(path: string, init: RequestInit, timeout: number) {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let responseStatus: number | undefined
    try {
      return await Promise.race([
        (async () => {
          const response = await options.request(path, { ...init, signal: controller.signal })
          responseStatus = response.status
          const body = await response.json()
          if (!response.ok || !body.batch) throw Object.assign(new Error(body.error ?? 'Publication paused. Resume reconciles saved progress.'), { status: response.status })
          return body.batch as BulkProgress
        })(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => {
          controller.abort()
          reject(Object.assign(new Error(init.method === 'POST' ? 'Bulk processing request timed out' : 'Bulk progress recovery timed out'), { name: 'TimeoutError' }))
        }, timeout) }),
      ])
    } catch (error) {
      // Preserve auth/authorization status even if its response body is absent or invalid.
      if (responseStatus && responseStatus >= 400 && error instanceof Error) Object.assign(error, { status: responseStatus })
      throw error
    } finally { clearTimeout(timer) }
  }
  let batch = options.batch
  let recovering = false, failures = 0
  while (!options.stopped()) {
    // Provider pauses require a new, explicit Resume even after retry_at has elapsed.
    if (batch.pause_reason === 'groq_rate_limit') return batch
    const counts = bulkCounts(batch)
    if (!counts.remaining && !counts.processing) return batch
    if (batch.retry_at && Date.parse(batch.retry_at) > Date.now()) {
      await options.wait(Math.min(Date.parse(batch.retry_at) - Date.now(), 5000))
      continue
    }
    // Pace publication attempts, never recovery GETs or time inside the server's 60s lease.
    if (!recovering && !counts.processing) {
      const remaining = bulkPacingUntil(batch) - Date.now()
      if (remaining > 0) {
        options.onNotice?.(`Next API in ${Math.ceil(remaining / 1000)} seconds (10-second spacing). Progress is saved.`)
        await options.wait(Math.min(remaining, 1000))
        continue
      }
      options.onNotice?.('Processing saved selection…')
    }
    const path = `/api/admin/free-api-worker/batches/${batch.id}`
    // Read while another request owns the lease; only the server may expire it.
    if (counts.processing) {
      options.onNotice?.('Waiting for the active API to finish. Progress is saved.')
      await options.wait(5000)
      recovering = true
    }
    if (options.stopped()) return batch
    try {
      const saved = await requestBatch(path, recovering ? { cache: 'no-store' }
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'next' }) }, recovering ? 10_000 : 75_000)
      // An unchanged read is safe to continue, but must not reset an outage's retry budget.
      if (!recovering || JSON.stringify(saved) !== JSON.stringify(batch)) failures = 0
      batch = saved
      recovering = false
      options.onProgress(batch)
      options.onNotice?.('Processing saved selection…')
    } catch (error) {
      const status = (error as { status?: number }).status
      const transient = status !== undefined ? [500, 502, 503, 504].includes(status)
        : error instanceof TypeError || error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)
      if (options.stopped() || !transient) throw error
      if (++failures >= 5) throw new Error('Connection recovery could not complete after 5 interruptions. Saved APIs have not been discarded.')
      const delay = Math.min(1000 * 2 ** (failures - 1), 8000)
      options.onNotice?.(`Connection interrupted. Recovering saved progress in ${delay / 1000} seconds (${failures}/4)…`)
      await options.wait(delay)
      // Never replay an ambiguous POST before a successful saved-state read.
      recovering = true
    }
  }
  return batch
}
