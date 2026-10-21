import { NextRequest } from 'next/server'
import { enforceRateLimit } from '@/lib/rate-limit'
import { readAgentDiscovery } from '@/lib/agent-discovery-document'

export const runtime = 'nodejs'
export async function GET(request: NextRequest) {
  const limited = await enforceRateLimit({ request, scope: 'agent-discover', limit: 120, windowSeconds: 60, failClosed: false })
  return limited ?? readAgentDiscovery(request)
}
