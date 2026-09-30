import { createServiceClient as baseClient } from '../marketplace/fixtures'
export const boundary = { actions: 0, unavailable: false, unavailableTable: null as string | null, external: 0 }
export function createServiceClient() {
  const db = baseClient()
  return {
    rpc: async (...args: Parameters<typeof db.rpc>) => {
      if (boundary.unavailable) return { data: null, error: { code: '42P01' } }
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
