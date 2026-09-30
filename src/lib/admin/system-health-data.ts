import 'server-only'
import vercelConfig from '../../../vercel.json'
import { createServiceClient } from '@/lib/supabase/server'
import { ARC_MAINNET } from '@/lib/arc'
import { withOperationsTtl } from './operations-cache'
import { readExpiredResponseBacklog } from './infrastructure-data'
import { runAdminDbRead } from './operations-data'
import type { OperationalSignalDto, SystemHealthDto } from './operations-types'

export const SYSTEM_HEALTH_TTL_MS = 60_000
type QueryResult<T> = { data: T | null; error: { message?: string } | null }

function signal(id: string, label: string, state: OperationalSignalDto['state'], detail: string, metadata?: string | null): OperationalSignalDto {
  return { id, label, state, detail, metadata }
}

async function x402StorageSignal(): Promise<OperationalSignalDto> {
  try {
    const db = createServiceClient()
    const result = await runAdminDbRead(() => db.from('x402_settlement_attempts').select('id').limit(1) as PromiseLike<QueryResult<Record<string, unknown>[]>>) as QueryResult<Record<string, unknown>[]>
    return result.error
      ? signal('x402-storage', 'x402 storage', 'unavailable', 'The bounded settlement storage readiness read failed.')
      : signal('x402-storage', 'x402 storage', 'ready', 'Settlement storage accepted a bounded read.')
  } catch { return signal('x402-storage', 'x402 storage', 'unavailable', 'Settlement storage was unavailable.') }
}

export function getSystemHealth(): Promise<SystemHealthDto> {
  return withOperationsTtl('system-health-v1', SYSTEM_HEALTH_TTL_MS, async () => {
    const [storage, backlog] = await Promise.all([x402StorageSignal(), readExpiredResponseBacklog()])
    const schedule = vercelConfig.crons.find(item => item.path === '/api/internal/maintenance/prune-responses')?.schedule ?? null
    const expiredCount = backlog?.count ?? 0
    const backlogState = backlog === null ? 'unavailable' : expiredCount > 100 ? 'degraded' : 'ready'
    const backlogDisplay = backlog?.capped ? `${expiredCount}+` : String(expiredCount)
    const deploymentSha = process.env.VERCEL_GIT_COMMIT_SHA?.trim()?.slice(0, 12)
    const discoveryConfigured = Boolean(process.env.GROQ_API_KEY?.trim()) && /^0x[0-9a-f]{40}$/i.test(process.env.PLATFORM_WALLET_ADDRESS?.trim() ?? '')
    return {
      signals: [
        signal('chain-config', 'Production chain', 'configured', `Arc Mainnet ${ARC_MAINNET.chainId} is the configured production chain.`, `eip155:${ARC_MAINNET.chainId}`),
        signal('deployment', 'Deployment SHA', deploymentSha ? 'configured' : 'unobserved', deploymentSha ? 'Deployment identity is configured.' : 'Deployment identity is not available in this runtime.', deploymentSha ?? null),
        signal('database', 'Database availability', storage.state === 'ready' ? 'ready' : 'unavailable', storage.state === 'ready' ? 'A bounded database read completed.' : 'The bounded database readiness read failed.'),
        storage,
        signal('response-retention', 'Response retention', 'configured', 'Recoverable response bodies have a configured seven-day retention policy.', '7 days'),
        signal('response-backlog', 'Expired response backlog', backlogState, backlog === null
          ? 'Backlog metadata is unavailable.'
          : expiredCount > 100
            ? 'Expired response metadata exceeds the conservative threshold.'
            : 'Current backlog is within the conservative threshold. This does not prove maintenance ran.', backlog === null ? null : `${backlogDisplay} expired`),
        signal('pruning-schedule', 'Pruning schedule', schedule ? 'configured' : 'unobserved', schedule ? 'The application deployment config includes response and wallet-auth pruning.' : 'No pruning schedule was found in application config.', schedule),
        signal('discovery', 'Discovery readiness', discoveryConfigured ? 'configured' : 'not_configured', discoveryConfigured
          ? 'Required discovery configuration is present; no model call was made.'
          : 'Required discovery configuration is incomplete; no model call was made.'),
      ],
      response_retention_days: 7,
      expired_response_backlog: expiredCount,
      expired_response_backlog_capped: backlog?.capped ?? false,
      as_of: new Date().toISOString(),
    }
  })
}
