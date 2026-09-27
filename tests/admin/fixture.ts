import { createServiceClient as baseClient } from '../marketplace/fixtures'
export const boundary = { actions: 0, unavailable: false, external: 0 }
export function createServiceClient() {
  const db = baseClient()
  return {
    rpc: async (...args: Parameters<typeof db.rpc>) => {
      if (boundary.unavailable) return { data: null, error: { code: '42P01' } }
      return db.rpc(...args)
    },
    from: (table: string) => {
      boundary.actions++
      const query = db.from(table)
      return Object.assign(query, { range: () => query })
    },
  }
}
export async function fetchPaidApis() { boundary.external++; return [] }
export async function fetchPublicApis() { throw new Error('Unexpected external crawl') }
export async function scoreForDiscovery() { throw new Error('Unexpected AI call') }
export function isSafeUrl() { throw new Error('Unexpected URL test') }
export async function safeOutboundFetch() { throw new Error('Unexpected outbound request') }
export async function proxyRequest() { throw new Error('Unexpected proxy') }
