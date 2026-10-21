import { NextRequest } from 'next/server'
import { readAgentDiscovery } from '@/lib/agent-discovery-document'
import { createMahsharMcpHandler } from '@/lib/mcp/server'

export const runtime = 'nodejs'

const handler = createMahsharMcpHandler({ loadPage: (url, signal) => readAgentDiscovery(new NextRequest(url, { signal })) })

export async function POST(request: Request) {
  return handler.fetch(request)
}
