// Browser fixtures only. Production providers and wallet integrations are never loaded.
export const wallet = '0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a'
export function useAccount() { return { address: wallet } }
export function useRouter() { return { push: path => { window.__navigation = path } } }
export function useMarketplaceSession() {
  const request = (path, init = {}) => fetch(path, init)
  const sensitiveRequest = (path, init = {}) => fetch(path, {
    ...init, headers: { ...init.headers, 'x-browser-fixture-proof': 'sign-synthetic-operation' },
  })
  return { request, sensitiveRequest }
}
