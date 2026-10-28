import 'server-only'
import { AsyncLocalStorage } from 'node:async_hooks'

export const BULK_TIMEOUT_ERROR = 'TIMEOUT: API processing exceeded 60 seconds. Draft and completed review retained; retry manually.'
export type BulkAttempt = { batch: string; candidate: string; token: string; deadline: number; signal: AbortSignal }
// Lazy initialization keeps Node-only setup out of the existing Workflow sandbox bundle.
let attempts: AsyncLocalStorage<BulkAttempt> | undefined
export const currentBulkAttempt = () => attempts?.getStore()
export function assertBulkAttempt(attempt = currentBulkAttempt()) {
  if (attempt && (attempt.signal.aborted || Date.now() >= attempt.deadline)) throw new Error(BULK_TIMEOUT_ERROR)
}

/** Scope cancellation and the database write fence to this Bulk List attempt only. */
export async function runBulkAttempt<T>(identity: Omit<BulkAttempt, 'signal'>, work: () => Promise<T>): Promise<T> {
  attempts ??= new AsyncLocalStorage<BulkAttempt>()
  const controller = new AbortController()
  const context = { ...identity, signal: controller.signal }
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error(BULK_TIMEOUT_ERROR)) }, Math.max(0, identity.deadline - Date.now()))
  })
  try {
    return await Promise.race([attempts.run(context, async () => { assertBulkAttempt(); return work() }), expired])
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

/** Captured per client, never a global fetch override. Ordinary Seller/Buyer clients are unchanged. */
export function bulkDatabaseFetch(): typeof fetch | undefined {
  const attempt = currentBulkAttempt()
  if (!attempt) return undefined
  return async (input, init) => {
    assertBulkAttempt(attempt)
    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
    headers.set('x-mahshar-bulk-attempt', JSON.stringify({ batch: attempt.batch, candidate: attempt.candidate, token: attempt.token }))
    const signals = [attempt.signal, init?.signal, input instanceof Request ? input.signal : null].filter(Boolean) as AbortSignal[]
    const response = await fetch(input, { ...init, headers, signal: AbortSignal.any(signals) })
    assertBulkAttempt(attempt)
    return response
  }
}
