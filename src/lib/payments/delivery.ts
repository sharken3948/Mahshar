import { createHash, randomUUID } from 'node:crypto'
import type { Attempt, Store } from './settlement'
import type { DeliveryOutcome } from '@/lib/proxy'

export type DeliveryState = 'NOT_STARTED' | 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED_RETRYABLE' | 'FAILED_FINAL' | 'UNKNOWN'

export class DeliveryRequestMismatchError extends Error {
  constructor() { super('Delivery request does not match the settled attempt'); this.name = 'DeliveryRequestMismatchError' }
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stable(object[key])}`).join(',')}}`
}

export function deliveryRequestHash(input: { apiId: string; method: string; target: string; body: unknown }): string {
  return createHash('sha256').update(stable({
    api_id: input.apiId,
    method: input.method.toUpperCase(),
    canonical_target: input.target,
    body: input.body === undefined ? null : input.body,
  })).digest('hex')
}

export type DeliveryStart =
  | { execute: true; token: string; attempt: Attempt }
  | { execute: false; attempt: Attempt }

export async function beginDelivery(store: Store, attemptId: string, requestHash: string): Promise<DeliveryStart> {
  const token = randomUUID()
  const attempt = await store.claimDelivery(attemptId, token, requestHash)
  return attempt.delivery_state === 'IN_PROGRESS' && attempt.delivery_token === token
    ? { execute: true, token, attempt }
    : { execute: false, attempt }
}

export async function finishDelivery(
  store: Store,
  attemptId: string,
  token: string,
  result: { deliveryOutcome: DeliveryOutcome; status: number; errorCode?: string },
): Promise<Attempt> {
  const state: Exclude<DeliveryState, 'NOT_STARTED' | 'IN_PROGRESS'> = {
    succeeded: 'SUCCEEDED',
    failed_retryable: 'FAILED_RETRYABLE',
    failed_final: 'FAILED_FINAL',
    unknown: 'UNKNOWN',
  }[result.deliveryOutcome] as Exclude<DeliveryState, 'NOT_STARTED' | 'IN_PROGRESS'>
  return store.completeDelivery(attemptId, token, state, result.status, result.errorCode ?? null)
}

export function deliveryError(attempt: Attempt) {
  const state = attempt.delivery_state ?? 'NOT_STARTED'
  const byState: Record<DeliveryState, { code: string; status: number; retryable: boolean }> = {
    NOT_STARTED: { code: 'delivery_not_started', status: 503, retryable: true },
    IN_PROGRESS: { code: 'delivery_in_progress', status: 409, retryable: true },
    SUCCEEDED: { code: 'delivery_succeeded', status: 200, retryable: false },
    FAILED_RETRYABLE: { code: 'delivery_retryable', status: 503, retryable: true },
    FAILED_FINAL: { code: 'delivery_failed_final', status: 409, retryable: false },
    UNKNOWN: { code: 'delivery_outcome_unknown', status: 409, retryable: false },
  }
  return { delivery_state: state, ...byState[state] }
}
