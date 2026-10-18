import { createServiceClient as baseClient } from '../marketplace/fixtures'
export const boundary = { actions: 0, unavailable: false, unavailableTable: null as string | null, external: 0, workflowStart: null as null | ((...args: unknown[]) => Promise<{ runId: string }>), rpcOverride: null as null | ((name: string, args: Record<string, unknown>) => Promise<any>) }
export function createServiceClient() {
  const db = baseClient()
  return {
    rpc: async (...args: Parameters<typeof db.rpc>) => {
      if (boundary.rpcOverride) return boundary.rpcOverride(String(args[0]), args[1] as Record<string, unknown>)
      if (boundary.unavailable) return { data: null, error: { code: '42P01' } }
      if (args[0] === 'mahshar_worker_mail_recover') return { data: { processed: 0, cursorBefore: null, cursorAfter: null }, error: null }
      if (args[0] === 'mahshar_worker_mail_checkpoint_recovery') return { data: true, error: null }
      if (args[0] === 'mahshar_worker_claim_pending_sources') return { data: [], error: null }
      if (args[0] === 'mahshar_worker_mail_claim_recovery') return { data: [], error: null }
      if (args[0] === 'mahshar_worker_mail_finish_recovery') return { data: null, error: null }
      if (args[0] === 'mahshar_worker_mail_discovery_state') return { data: ((args[1] as { p_domains: string[] }).p_domains).map(domain => ({ domain, provider_id: null, reason: null })), error: null }
      return db.rpc(...args)
    },
    from: (table: string) => {
      boundary.actions++
      if (boundary.unavailable || boundary.unavailableTable === table) {
        const failed: any = {}
        for (const method of ['select','eq','not','is','order','limit','range']) failed[method] = () => failed
        failed.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: null, count: null, error: { code: '42P01', message: 'fixture unavailable' } }).then(resolve)
        return failed
      }
      const query = db.from(table)
      return query
    },
  }
}
export async function fetchPaidApis() { boundary.external++; return [] }
export async function fetchPublicApis() { throw new Error('Unexpected external crawl') }
export async function scoreForDiscovery() { throw new Error('Unexpected AI call') }
export function isSafeUrl() { throw new Error('Unexpected URL test') }
export async function safeOutboundFetch() { throw new Error('Unexpected outbound request') }
export async function proxyRequest() { throw new Error('Unexpected proxy') }
