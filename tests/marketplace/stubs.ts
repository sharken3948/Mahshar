import { NextResponse } from 'next/server.js'
import { alice, state } from './fixtures'
export async function validateEndpointUrl(url: string) { return { valid: url.startsWith('https://') } }
export async function scoreApi() { return { score: 9, approved: true } }
export async function verifyAndSettlePayment() { state.settled++; return { success: true, payer: alice.address.toLowerCase(), callId: 'purchase' } }
export async function paymentInfrastructureStatus() { return { ready: true as const } }
export function build402Response() { return NextResponse.json({}, { status: 402 }) }
export async function writeMemo() {}
