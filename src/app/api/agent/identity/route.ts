import { NextRequest, NextResponse } from 'next/server'
import { AgentIdentityError, IDENTITY_CHAIN_ID, IDENTITY_REGISTRY,
  parseIdentityQuery, readAgentIdentity } from '@/lib/agent-identity'
import { enforceRateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }

/** No cookies, signatures, purchase tokens, private buyer data or identity writes. */
export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams
    if (params.size === 0) {
      return NextResponse.json({
        schema_version: '1', mode: 'public_onchain_lookup', method: 'GET',
        chain_id: IDENTITY_CHAIN_ID, registry: IDENTITY_REGISTRY,
        required_query: ['chain_id', 'registry', 'agent_id'], optional_query: ['wallet'],
        agent_id_format: 'canonical uint256 decimal string; zero is valid',
        requester_authenticated: false, persistent_binding_supported: false,
        semantics: 'Verifies registry facts at the returned block. A wallet comparison does not prove requester control or grant permissions.',
        errors: { '400': 'invalid_identity_query', '404': 'agent_not_found',
          '429': 'rate_limited', '503': ['identity_unavailable', 'rate_limit_unavailable'] },
      }, { headers })
    }
    const query = parseIdentityQuery(params)
    // Separate IP budget; caller-supplied wallets must not determine the budget.
    const limited = await enforceRateLimit({ request, scope: 'agent-identity', limit: 30,
      windowSeconds: 60, failClosed: true })
    if (limited) return limited
    return NextResponse.json(await readAgentIdentity(query), { headers })
  } catch (error) {
    const known = error instanceof AgentIdentityError
    return NextResponse.json({ error: known ? error.code : 'identity_unavailable',
      requester_authenticated: false, binding_created: false },
    { status: known ? error.status : 503, headers })
  }
}
