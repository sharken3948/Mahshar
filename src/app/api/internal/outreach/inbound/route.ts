import { authenticateInboundBridge, inboundBridgeConfigured, parseNormalizedInboundReply,
  processInboundReply, readBoundedInboundJson } from '@/lib/admin-outreach/inbound'

export const runtime = 'nodejs'

export async function POST(request: Request) {
  if (!inboundBridgeConfigured()) return Response.json({ error: 'inbound_not_configured' }, { status: 503 })
  if (!authenticateInboundBridge(request)) return Response.json({ error: 'unauthorized' }, { status: 401 })
  try {
    const reply = parseNormalizedInboundReply(await readBoundedInboundJson(request))
    const result = await processInboundReply(reply)
    return Response.json({ accepted: true, duplicate: result.duplicate, matched: Boolean(result.threadId),
      processingState: result.processingState })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'admin_outreach_inbound_unavailable'
    if (message === 'admin_outreach_inbound_too_large') return Response.json({ error: 'payload_too_large' }, { status: 413 })
    if (message === 'admin_outreach_inbound_invalid') return Response.json({ error: 'invalid_payload' }, { status: 400 })
    console.error('[admin-outreach] inbound processing unavailable', message)
    return Response.json({ error: 'inbound_unavailable' }, { status: 503 })
  }
}
