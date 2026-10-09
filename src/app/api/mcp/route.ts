import { createMahsharMcpHandler } from '@/lib/mcp/server'

export const runtime = 'nodejs'

const handler = createMahsharMcpHandler()

export async function POST(request: Request) {
  return handler.fetch(request)
}
