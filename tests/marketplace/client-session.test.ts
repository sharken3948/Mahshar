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
test('wallet authorization client has no session, cookie, consent, or retry state', () => {
  const source = readFileSync('src/hooks/useWalletAuthorization.ts', 'utf8')
  assert.match(source, /useSignTypedData/)
  assert.match(source, /crypto\.getRandomValues/)
  assert.match(source, /Wallet changed/)
  assert.doesNotMatch(source, /cookie|session|consent|challenge|logout|retry|signMessage/)
})
test('read-only dashboard refresh never invokes wallet authorization', () => {
  const source = readFileSync('src/app/dashboard/dashboard-workspace.tsx', 'utf8')
  const reads = source.slice(source.indexOf('const fetchReadOnlySellerStatistics'), source.indexOf('async function beginEditApi'))
  assert.match(reads, /fetchReadOnlySellerStatistics/)
  assert.match(source, /useVisibilityRefresh\(refreshMarketplaceData/)
  assert.doesNotMatch(reads, /authorizedFetch\(/)
  const ownerEdit = source.slice(source.indexOf('async function beginEditApi'), source.indexOf('async function handleDeposit'))
  assert.match(ownerEdit, /authorizedFetch\(`\/api\/apis\/\$\{encodeURIComponent\(apiId\)\}`\)/)
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
  assert.match(buyer, /coalescedJsonGet[^\n]+`\/api\/calls\?buyer_wallet=\$\{address\.toLowerCase\(\)\}`/)
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

test('buyer initial datasets use in-flight read coalescing', () => {
  const source = readFileSync('src/app/buyer/page.tsx', 'utf8')
  assert.match(source, /coalescedJsonGet[^\n]+\('\/api\/apis'\)/)
  assert.match(source, /coalescedJsonGet[^\n]+\('\/api\/apis\/latency'\)/)
  assert.match(source, /coalescedJsonGet[^\n]+`\/api\/calls\?buyer_wallet=/)
})
