import 'server-only'
import { arcPrivateMainnetHeaders } from '@circle-fin/x402-batching/client'
import { createServiceClient } from '@/lib/supabase/server'
import { ARC_MAINNET } from '@/lib/arc'
import { withOperationsTtl } from './operations-cache'
import { runAdminDbRead } from './operations-data'
import type { InfrastructureDto, OperationalSignalDto } from './operations-types'

export const INFRASTRUCTURE_TTL_MS = 60_000
export const ARC_RPC_TIMEOUT_MS = 3_500
export const GATEWAY_CAPABILITIES_TIMEOUT_MS = 4_000
export const GATEWAY_CAPABILITIES_URL = `${ARC_MAINNET.gatewayApi}/x402/supported`
const RESPONSE_BACKLOG_BOUND = 101

type QueryResult<T> = { data: T | null; error: { message?: string } | null }

function signal(id: string, label: string, state: OperationalSignalDto['state'], detail: string, metadata?: string | null): OperationalSignalDto {
  return { id, label, state, detail, metadata }
}

export function gatewaySupportsArc(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const kinds = (value as { kinds?: unknown }).kinds
  return Array.isArray(kinds) && kinds.some(kind => kind && typeof kind === 'object' &&
    (kind as { network?: unknown }).network === 'eip155:5042')
}

export function arcChainIdFromRpc(value: unknown): number | null {
  const records = Array.isArray(value) ? value : [value]
  const result = records.find(item => item && typeof item === 'object' && (item as { id?: unknown }).id === 1) as { result?: unknown } | undefined
  if (!result || typeof result.result !== 'string' || !/^0x[0-9a-f]+$/i.test(result.result)) return null
  const parsed = Number.parseInt(result.result, 16)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function blockFromRpc(value: unknown): string | null {
  const records = Array.isArray(value) ? value : [value]
  const result = records.find(item => item && typeof item === 'object' && (item as { id?: unknown }).id === 2) as { result?: unknown } | undefined
  if (!result || typeof result.result !== 'string' || !/^0x[0-9a-f]+$/i.test(result.result)) return null
  try { return BigInt(result.result).toString() } catch { return null }
}

async function probeArcRpc(): Promise<OperationalSignalDto> {
  const rpcUrl = process.env.ARC_MAINNET_RPC_URL?.trim()
  if (!rpcUrl) return signal('arc-rpc', 'Arc Mainnet RPC', 'not_configured', 'ARC_MAINNET_RPC_URL is not configured.')
  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([
        { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] },
        { jsonrpc: '2.0', id: 2, method: 'eth_blockNumber', params: [] },
      ]),
      signal: AbortSignal.timeout(ARC_RPC_TIMEOUT_MS),
      cache: 'no-store',
    })
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); return signal('arc-rpc', 'Arc Mainnet RPC', 'degraded', 'The fixed RPC read returned an unsuccessful status.') }
    const body: unknown = await response.json().catch(() => null)
    const chainId = arcChainIdFromRpc(body)
    if (chainId !== ARC_MAINNET.chainId) return signal('arc-rpc', 'Arc Mainnet RPC', 'degraded', 'The configured RPC did not prove Arc Mainnet chain 5042.', chainId === null ? null : `Observed chain ${chainId}`)
    const block = blockFromRpc(body)
    return signal('arc-rpc', 'Arc Mainnet RPC', 'ready', 'Read-only chain identity confirmed Arc Mainnet 5042.', block ? `Block ${block}` : 'Block height unobserved')
  } catch { return signal('arc-rpc', 'Arc Mainnet RPC', 'unavailable', 'The fixed read-only RPC probe timed out or was unavailable.') }
}

async function probeGateway(): Promise<OperationalSignalDto> {
  try {
    const response = await fetch(GATEWAY_CAPABILITIES_URL, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json', ...arcPrivateMainnetHeaders(true) },
      signal: AbortSignal.timeout(GATEWAY_CAPABILITIES_TIMEOUT_MS),
      cache: 'no-store',
    })
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); return signal('circle-gateway', 'Circle / Gateway', 'degraded', 'The supported-capabilities read returned an unsuccessful status.') }
    const body: unknown = await response.json().catch(() => null)
    return gatewaySupportsArc(body)
      ? signal('circle-gateway', 'Circle / Gateway', 'ready', 'Supported capabilities include eip155:5042.', 'Read-only /v1/x402/supported')
      : signal('circle-gateway', 'Circle / Gateway', 'degraded', 'Supported capabilities did not prove eip155:5042 support.')
  } catch { return signal('circle-gateway', 'Circle / Gateway', 'unavailable', 'The fixed supported-capabilities read timed out or was unavailable.') }
}

async function probeDatabase(): Promise<OperationalSignalDto> {
  try {
    const db = createServiceClient()
    const result = await runAdminDbRead(() => db.from('api_listings').select('id').limit(1) as PromiseLike<QueryResult<Record<string, unknown>[]>>) as QueryResult<Record<string, unknown>[]>
    return result.error ? signal('supabase', 'Supabase', 'unavailable', 'A bounded non-sensitive read failed.') : signal('supabase', 'Supabase', 'ready', 'A bounded non-sensitive read completed.')
  } catch { return signal('supabase', 'Supabase', 'unavailable', 'A bounded non-sensitive read was unavailable.') }
}

export async function readExpiredResponseBacklog(): Promise<{ count: number; capped: boolean } | null> {
  try {
    const db = createServiceClient()
    const result = await runAdminDbRead(() => db.from('api_calls')
      .select('id, response_expires_at')
      .not('response_body', 'is', null)
      .lte('response_expires_at', new Date().toISOString())
      .limit(RESPONSE_BACKLOG_BOUND) as PromiseLike<QueryResult<Record<string, unknown>[]>>) as QueryResult<Record<string, unknown>[]>
    if (result.error) return null
    const count = result.data?.length ?? 0
    return { count, capped: count >= RESPONSE_BACKLOG_BOUND }
  } catch { return null }
}

async function probeResponseStorage(): Promise<OperationalSignalDto> {
  const backlog = await readExpiredResponseBacklog()
  if (!backlog) return signal('response-storage', 'Response storage', 'unavailable', 'Bounded retention metadata could not be read.')
  const display = backlog.capped ? `${backlog.count}+` : String(backlog.count)
  return signal('response-storage', 'Response storage', backlog.count > 100 ? 'degraded' : 'ready',
    backlog.count > 100 ? 'Expired response metadata exceeds the conservative backlog threshold.' : 'Retention metadata is readable.', `${display} expired response${backlog.count === 1 ? '' : 's'}`)
}

export function getInfrastructureStatus(): Promise<InfrastructureDto> {
  return withOperationsTtl('infrastructure-v1', INFRASTRUCTURE_TTL_MS, async () => {
    const [arc, gateway, database, responses] = await Promise.all([
      probeArcRpc(), probeGateway(), probeDatabase(), probeResponseStorage(),
    ])
    const runtimeMetadata = [process.env.VERCEL_ENV?.trim(), process.env.VERCEL_REGION?.trim(), process.env.VERCEL_GIT_COMMIT_SHA?.trim()?.slice(0, 12)].filter(Boolean).join(' · ')
    return {
      signals: [
        arc,
        gateway,
        database,
        signal('groq', 'Groq', process.env.GROQ_API_KEY?.trim() ? 'configured' : 'not_configured',
          process.env.GROQ_API_KEY?.trim() ? 'Configured / Unobserved. No inference health call is made.' : 'Not configured. No inference health call is made.'),
        signal('rate-limiter', 'Rate limiter', 'unobserved', 'No synthetic rate-limit write is performed.'),
        responses,
        signal('runtime', 'Vercel / Runtime', 'configured', 'Deployment metadata reported by the runtime environment.', runtimeMetadata || 'Local or metadata unavailable'),
      ],
      as_of: new Date().toISOString(),
    }
  })
}
