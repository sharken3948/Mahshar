export type GatewayTransferAccepted = {
  kind: 'accepted'
  attestation: `0x${string}`
  signature: `0x${string}`
  transferId: string | null
}

export type GatewayTransferOutcome = GatewayTransferAccepted | {
  kind: 'rejected'
  transferId: string | null
  detail: string
} | {
  kind: 'unknown'
  transferId: string | null
  detail: string
}

type JsonObject = Record<string, unknown>

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null
}

function boundedString(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null
}

function hex(value: unknown, max: number): `0x${string}` | null {
  const text = boundedString(value, max)
  return text && /^0x(?:[0-9a-fA-F]{2})+$/.test(text) ? text as `0x${string}` : null
}

function transferId(body: JsonObject | null) {
  return boundedString(body?.transferId, 512)
}

function detail(body: JsonObject | null, fallback: string) {
  return boundedString(body?.message, 1024) ?? boundedString(body?.error, 1024) ?? fallback
}

/**
 * A transfer is accepted only with a complete attestation. A rejection is
 * considered definitive only when Gateway returned a validation/auth status
 * and a well-formed explicit failure. Every other post-dispatch result is
 * ambiguous and must keep the seller reservation consumed.
 */
export function classifyGatewayTransferResponse(status: number, value: unknown): GatewayTransferOutcome {
  const body = object(value)
  const id = transferId(body)
  const attestation = hex(body?.attestation, 64 * 1024)
  const signature = hex(body?.signature, 1024)
  if (status >= 200 && status < 300 && attestation && signature) {
    return { kind: 'accepted', attestation, signature, transferId: id }
  }
  if ([400, 401, 403, 422].includes(status) && body?.success === false && boundedString(body.message, 1024)) {
    return { kind: 'rejected', transferId: id, detail: detail(body, `Gateway rejected transfer (${status})`) }
  }
  return { kind: 'unknown', transferId: id, detail: detail(body, `Ambiguous Gateway transfer response (${status})`) }
}

export type GatewayTransferStatus = GatewayTransferAccepted | {
  kind: 'pending' | 'rejected' | 'unknown'
  detail: string
}

export function classifyGatewayTransferStatus(value: unknown): GatewayTransferStatus {
  const body = object(value)
  const status = body?.status
  if (body && (status === 'failed' || status === 'expired')) {
    return { kind: 'rejected', detail: detail(object(body.forwardingDetails), `Gateway transfer ${status}`) }
  }
  if (status === 'pending') return { kind: 'pending', detail: 'Gateway transfer is pending' }
  if (status === 'confirmed' || status === 'finalized') {
    const attestationBody = object(body?.attestation)
    const attestation = hex(attestationBody?.payload, 64 * 1024)
    const signature = hex(attestationBody?.signature, 1024)
    if (attestation && signature) {
      return { kind: 'accepted', attestation, signature, transferId: null }
    }
  }
  return { kind: 'unknown', detail: 'Gateway transfer status response was invalid or incomplete' }
}
