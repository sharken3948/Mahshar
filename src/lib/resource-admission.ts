import 'server-only'
import { NextResponse } from 'next/server'
import { privateResourceScope, reserveResource, resourceLimit, resourceBudgetEnabled, ResourceBudgetError } from '@/lib/resource-budget'

/** Bounded operational admission; deliberately excluded from payment and recovery paths. */
export async function resourceAdmission(kind: 'listing-create' | 'onramp' | 'verification', wallet: string) {
  const prefix = kind === 'listing-create' ? 'LISTING_CREATE' : kind === 'onramp' ? 'ONRAMP' : 'VERIFICATION'
  if (!resourceBudgetEnabled(prefix)) return { response: null, release: async () => {} }
  try {
    const release = await reserveResource({ buckets: [
      { scope: `${kind}:day`, window_seconds: 86400,
        request_limit: resourceLimit(`MAHSHAR_${prefix}_GLOBAL_DAY`), unit_limit: 1 },
      { scope: privateResourceScope(`${kind}:wallet`, wallet), window_seconds: 86400,
        request_limit: resourceLimit(`MAHSHAR_${prefix}_WALLET_DAY`), unit_limit: 1 },
    ], ...(kind === 'listing-create' ? {} : {
      leaseScope: `operational:${kind}`, concurrency: resourceLimit(`MAHSHAR_${prefix}_CONCURRENCY`, undefined, 32),
    }) })
    return { response: null, release }
  } catch (error) {
    const unavailable = !(error instanceof ResourceBudgetError) || error.unavailable
    return { release: async () => {}, response: NextResponse.json({ error: unavailable ? 'resource_budget_unavailable' : 'resource_budget_exhausted' }, {
      status: unavailable ? 503 : 429,
      headers: { 'Retry-After': String(error instanceof ResourceBudgetError ? error.retryAfter : 60), 'Cache-Control': 'no-store' },
    }) }
  }
}
