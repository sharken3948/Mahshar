import 'server-only'
import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { authorizeProxyTarget } from '@/lib/marketplace/proxy-target'
import { fetchUpstreamWithoutRedirects, readResponseBytes, MAX_SAFE_SERIALIZED_RESPONSE_BYTES, serializedJsonByteLength } from '@/lib/proxy-response'
import { OWNER } from './model'

/** Free public delivery has no purchase, wallet, settlement, or financial side effects. */
export async function deliverFreeListing(id: string, target: string) {
  const { data: row, error } = await createServiceClient().from('api_listings').select('*').eq('id', id).single()
  if (error || !row?.is_active || !row.verified_at || !row.free_worker_candidate_id || row.seller_wallet !== OWNER
    || Number(row.price_per_call) !== 0 || row.method !== 'GET' || row.auth_type !== 'public' || row.encrypted_key) {
    return NextResponse.json({ error: 'Free listing unavailable; reload its current configuration.' }, { status: 409 })
  }
  try {
    if (authorizeProxyTarget(row, '').toString() !== target) return NextResponse.json({ error: 'Listing configuration changed' }, { status: 409 })
    const start = Date.now()
    const response = await fetchUpstreamWithoutRedirects(target, { method: 'GET', signal: AbortSignal.timeout(30_000), headers: { accept: 'application/json, text/plain;q=0.9, */*;q=0.5' } })
    if (!response.ok) { await response.body?.cancel(); return NextResponse.json({ error: 'Upstream unavailable', upstream_status: response.status }, { status: 502 }) }
    const bytes = await readResponseBytes(response.body, MAX_SAFE_SERIALIZED_RESPONSE_BYTES)
    const raw = new TextDecoder().decode(bytes)
    let result: unknown = raw
    try { result = JSON.parse(raw) } catch { /* Same JSON envelope supports text responses. */ }
    const body = { response: result, latency_ms: Date.now() - start, payment: 'FREE' }
    if (serializedJsonByteLength(body) > MAX_SAFE_SERIALIZED_RESPONSE_BYTES) throw new Error('Response too large')
    return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } })
  } catch { return NextResponse.json({ error: 'Free upstream delivery unavailable' }, { status: 502 }) }
}
