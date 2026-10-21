import 'server-only'
import { createHash } from 'node:crypto'
import { createServiceClient } from '@/lib/supabase/server'
import { withDeadline } from '@/lib/request-deadline'

export type ResourceBucket = {
  scope: string; window_seconds: number; request_limit: number; unit_limit: number
}
export type BudgetDatabase = {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> & {
    abortSignal?: (signal: AbortSignal) => PromiseLike<{ data: unknown; error: unknown }>
  }
}

export class ResourceBudgetError extends Error {
  constructor(readonly unavailable = false, readonly retryAfter = 60) {
    super(unavailable ? 'resource_budget_unavailable' : 'resource_budget_exhausted')
    this.name = 'ResourceBudgetError'
  }
}

export function resourceLimit(name: string, fallback?: number, maximum = 100_000_000): number {
  const raw = process.env[name]
  if (raw === undefined && fallback !== undefined) return fallback
  if (raw === undefined) throw new ResourceBudgetError(true)
  const value = Number(raw)
  // A configuration typo must not silently remove a cost ceiling.
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new ResourceBudgetError(true)
  }
  return value
}

/** Disabled until the operator explicitly approves and configures this policy. */
export function resourceBudgetEnabled(prefix: string) {
  return process.env[`MAHSHAR_${prefix}_BUDGET_ENABLED`] === 'true'
}

async function budgetRpc(database: BudgetDatabase, name: string, args: Record<string, unknown>, timeout: number) {
  return withDeadline(timeout, signal => {
    const query = database.rpc(name, args)
    return query.abortSignal ? query.abortSignal(signal) : query
  })
}

export function privateResourceScope(prefix: string, identity: string) {
  return `${prefix}:${createHash('sha256').update(identity.toLowerCase()).digest('hex')}`
}

export async function reserveResource(input: {
  buckets: ResourceBucket[]; units?: number; concurrency?: number; leaseScope?: string
  database?: BudgetDatabase
}): Promise<() => Promise<void>> {
  const database = input.database ?? createServiceClient()
  let result: { allowed?: boolean; lease_id?: string | null; retry_after_seconds?: number } | undefined
  try {
    const { data, error } = await budgetRpc(database, 'mahshar_reserve_resource', {
      p_buckets: input.buckets, p_units: input.units ?? 0,
      p_lease_scope: input.leaseScope ?? null, p_concurrency: input.concurrency ?? 0,
    }, 2000)
    if (error) throw error
    result = (Array.isArray(data) ? data[0] : data) as typeof result
    if (!result || typeof result.allowed !== 'boolean' ||
      (result.allowed && input.leaseScope && typeof result.lease_id !== 'string')) throw new Error('invalid_budget_result')
  } catch {
    throw new ResourceBudgetError(true)
  }
  if (!result?.allowed) throw new ResourceBudgetError(false, Math.max(1, result?.retry_after_seconds ?? 60))
  const leaseId = result.lease_id
  let released = false
  return async () => {
    if (!leaseId || released) return
    released = true
    try {
      const { error } = await budgetRpc(database, 'mahshar_release_resource', { p_lease_id: leaseId }, 250)
      if (error) throw error
    } catch {
      // The lease expires after 60 seconds. Never mask a completed provider response.
      console.error('[resource-budget] lease release unavailable')
    }
  }
}
