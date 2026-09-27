import { NextResponse } from 'next/server'

export const runtime = 'nodejs'

/** Retired: never forward a legacy signature or initiate an upstream payment. */
export async function POST(_request: Request) {
  return NextResponse.json({
    error: 'legacy_x402_retired',
    message: 'Use the v2 Payment-Signature flow at /api/proxy or /api/proxy/{api_id}.',
    replacement: '/api/proxy',
  }, { status: 410, headers: { 'Cache-Control': 'no-store' } })
}
