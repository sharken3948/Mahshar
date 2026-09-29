import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { hashAuthorizationPayload, operationFor, queryPayload } from '../../src/lib/marketplace/operation-authorization'
import { coalescedJsonGet } from '../../src/lib/client-read'
import { clearPurchaseAccessMemoryCache, PURCHASE_ACCESS_HEADER, purchaseAccess, readPurchasedResponse } from '../../src/lib/marketplace/purchase-access-client'

test('authorization payload hashing is canonical and mutation-sensitive', () => {
  assert.equal(hashAuthorizationPayload({ b: 2, a: { d: 4, c: 3 } }), hashAuthorizationPayload({ a: { c: 3, d: 4 }, b: 2 }))
  assert.notEqual(hashAuthorizationPayload({ price: 1 }), hashAuthorizationPayload({ price: 2 }))
})
test('operation identity binds HTTP method and path while query is payload-bound', () => {
  assert.equal(operationFor('patch', '/api/apis/123'), 'PATCH /api/apis/123')
  assert.deepEqual(queryPayload(new URL('https://mahshar.xyz/api/calls?b=2&a=1')), { query: [['a', '1'], ['b', '2']] })
})
test('wallet authentication validates the server session before deduplicated login work', () => {
  const compatibility = readFileSync('src/hooks/useWalletAuthorization.ts', 'utf8')
  const source = readFileSync('src/components/MarketplaceSessionProvider.tsx', 'utf8')
  assert.match(compatibility, /return useMarketplaceSession\(\)/)
  assert.match(source, /type SessionCheckResult = 'authenticated' \| 'unauthenticated' \| 'unavailable'/)
  assert.match(source, /const loginInFlight = new Map<string, Promise<LoginResult>>/)
  assert.match(source, /const checkInFlight = new Map<string, Promise<SessionCheckResult>>/)
  assert.match(source, /const checked = await initializeSession\(requestedWallet\)/)
  assert.match(source, /if \(checked === 'authenticated'\) return true/)
  assert.doesNotMatch(source.slice(source.indexOf('const checkSession'), source.indexOf('const initializeSession')), /signal:/)
  assert.match(source, /serializeSignature/)
  assert.match(source, /credentials: 'same-origin'/)
  assert.match(source, /signTypedDataAsync/)
  assert.match(source, /rejectedWallet/)
  assert.doesNotMatch(source, /localStorage|sessionStorage|document\.cookie/)
})
test('sensitive listing authorization is explicit and never automatically replayed', () => {
  const provider = readFileSync('src/components/MarketplaceSessionProvider.tsx', 'utf8')
  const sensitive = provider.slice(provider.indexOf('const sensitiveRequest'), provider.indexOf('\n\n  useEffect', provider.indexOf('const sensitiveRequest')))
  assert.match(sensitive, /OPERATION_AUTH_HEADER/)
  assert.match(sensitive, /serializeSignature/)
  assert.doesNotMatch(sensitive, /response\.status !== 401|return fetch\(input[\s\S]*return fetch\(input/)
  const editor = readFileSync('src/components/EditListingForm.tsx', 'utf8')
  assert.match(editor, /requiresFreshAuthorization \? sensitiveRequest : marketplaceFetch/)
  assert.match(editor, /FRESH_AUTHORIZATION_FIELDS/)
})
test('dashboard private accounting refreshes require wallet authorization', () => {
  const source = readFileSync('src/app/dashboard/dashboard-workspace.tsx', 'utf8')
  const reads = source.slice(source.indexOf('const fetchReadOnlySellerStatistics'), source.indexOf('async function beginEditApi'))
  assert.match(reads, /fetchReadOnlySellerStatistics/)
  assert.match(source, /useVisibilityRefresh\(refreshMarketplaceData/)
  assert.match(source, /privateFetch\(wallet, `\/api\/seller\/statistics\/\$\{encodeURIComponent\(wallet\)\}`/)
  assert.match(reads, /privateFetch\(wallet, `\/api\/calls\?buyer_wallet=/)
  assert.match(reads, /privateFetch\(wallet, `\/api\/seller\/calls\?seller_wallet=/)
  assert.match(source, /privateFetch\(wallet, `\/api\/gateway\/balance\?wallet=/)
  assert.match(source, /if \(!isCurrentWallet\(wallet\)\) return false/)
  const ownerEdit = source.slice(source.indexOf('async function beginEditApi'), source.indexOf('async function handleDeposit'))
  assert.match(ownerEdit, /privateFetch\(wallet, `\/api\/apis\/\$\{encodeURIComponent\(apiId\)\}`\)/)
  assert.match(ownerEdit, /if \(!isCurrentWallet\(wallet\)\) return/)
})
test('purchased-response views prefer a purchase capability over wallet authorization', () => {
  for (const path of ['src/app/buyer/page.tsx', 'src/app/dashboard/dashboard-workspace.tsx']) {
    const source = readFileSync(path, 'utf8')
    const view = source.slice(source.indexOf('async function handleViewApi'), source.indexOf('\n  return {', source.indexOf('async function handleViewApi')) > 0
      ? source.indexOf('\n  return {', source.indexOf('async function handleViewApi'))
      : source.indexOf('\n  if (!isConnected)', source.indexOf('async function handleViewApi')))
    assert.match(view, /readPurchasedResponse\(\{ wallet: address, apiId, authorize:/, path)
  }
})
test('legacy purchases remain visible in both buyer View API surfaces', () => {
  const buyer = readFileSync('src/app/buyer/page.tsx', 'utf8')
  assert.match(buyer, /protectedFetch\(`\/api\/calls\?buyer_wallet=\$\{address\.toLowerCase\(\)\}`\)/)
  assert.match(buyer, /setPurchasedApiIds\(new Set\(data\.calls\?\.map\(call => call\.api_id\)/)
  assert.match(buyer, /purchased=\{purchasedApiIds\.has\(api\.id\)\}/)

  const dashboard = readFileSync('src/app/dashboard/dashboard-workspace.tsx', 'utf8')
  assert.match(dashboard, /const fetchBuyerCalls = useCallback/)
  assert.match(dashboard, /privateSnapshotLoadedRef\.current \? loadPrivateSnapshot\(\) : fetchBuyerCalls\(\)/)
  const page = readFileSync('src/app/dashboard/apis/page.tsx', 'utf8')
  assert.match(page, /groups=\{callGroups\} buyer[^>]+onView=\{handleViewApi\}/)
})

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: key => values.get(key) ?? null,
    key: index => [...values.keys()][index] ?? null,
    removeItem: key => { values.delete(key) },
    setItem: (key, value) => { values.set(key, value) },
  }
}

test('legacy capability persists across clicks and a page-refresh memory reset', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: memoryStorage() } })
  clearPurchaseAccessMemoryCache()
  try {
    const wallet = '0xAbCdEfabcdefABCDEFabcdefabcdefABCDEFabcd'
    const apiId = 'ABC-123'
    let signatures = 0
    let authorizedReads = 0
    let capabilityReads = 0
    const authorize = async () => {
      signatures++
      authorizedReads++
      return Response.json({ response_body: 'private', purchase_access_token: 'saved-capability' })
    }
    const fetcher: typeof fetch = async (_input, init) => {
      capabilityReads++
      assert.equal(new Headers(init?.headers).get(PURCHASE_ACCESS_HEADER), 'saved-capability')
      return Response.json({ response_body: 'private', purchase_access_token: 'saved-capability' })
    }

    assert.equal((await readPurchasedResponse({ wallet, apiId, authorize, fetcher })).data.response_body, 'private')
    assert.equal(signatures, 1)
    assert.equal(authorizedReads, 1)

    const [second, duplicateSecond] = await Promise.all([
      readPurchasedResponse({ wallet: wallet.toLowerCase(), apiId: apiId.toLowerCase(), authorize, fetcher }),
      readPurchasedResponse({ wallet, apiId, authorize, fetcher }),
    ])
    assert.equal(second.data.response_body, 'private')
    assert.equal(duplicateSecond.data.response_body, 'private')
    assert.equal(signatures, 1)
    assert.equal(capabilityReads, 1)

    clearPurchaseAccessMemoryCache()
    assert.equal((await readPurchasedResponse({ wallet, apiId, authorize, fetcher })).data.response_body, 'private')
    assert.equal(signatures, 1)
    assert.equal(capabilityReads, 2)
    assert.equal(purchaseAccess('0x1111111111111111111111111111111111111111', apiId), null)
  } finally {
    clearPurchaseAccessMemoryCache()
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('a rejected capability read does not silently fall back to a wallet signature', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const storage = memoryStorage()
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: storage } })
  clearPurchaseAccessMemoryCache()
  try {
    storage.setItem('mahshar.purchase-access.v1:0x1111111111111111111111111111111111111111:api', 'rejected-capability')
    let signatures = 0
    let reads = 0
    const result = await readPurchasedResponse({
      wallet: '0x1111111111111111111111111111111111111111',
      apiId: 'api',
      authorize: async () => { signatures++; return Response.json({}, { status: 401 }) },
      fetcher: async () => { reads++; return Response.json({ error: 'Invalid purchase access' }, { status: 401 }) },
    })
    assert.equal(result.status, 401)
    assert.equal(reads, 1)
    assert.equal(signatures, 0)
  } finally {
    clearPurchaseAccessMemoryCache()
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('identical initial reads coalesce only while in flight', async () => {
  let requests = 0
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const fetcher: typeof fetch = async () => {
    requests++
    await gate
    return Response.json({ value: 1 })
  }
  const first = coalescedJsonGet<{ value: number }>('/api/test/coalesced', fetcher)
  const duplicate = coalescedJsonGet<{ value: number }>('/api/test/coalesced', fetcher)
  assert.equal(requests, 1)
  release()
  assert.equal((await first).data.value, 1)
  assert.equal((await duplicate).data.value, 1)
  await coalescedJsonGet('/api/test/coalesced', fetcher)
  assert.equal(requests, 2)
})

test('buyer public datasets coalesce while private purchase history uses wallet proof', () => {
  const source = readFileSync('src/app/buyer/page.tsx', 'utf8')
  assert.match(source, /coalescedJsonGet[^\n]+\('\/api\/apis'\)/)
  assert.match(source, /coalescedJsonGet[^\n]+\('\/api\/apis\/latency'\)/)
  assert.match(source, /protectedFetch\(`\/api\/calls\?buyer_wallet=/)
  assert.doesNotMatch(source, /coalescedJsonGet[^\n]+`\/api\/calls\?buyer_wallet=/)
})
