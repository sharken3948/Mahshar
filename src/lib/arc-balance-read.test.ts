import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Address } from 'viem'
import { ArcBalanceReader, type ArcBalanceSource } from './arc-balance-read'
import { arcBalanceSources } from './arc-balance-client'

const wallet = ('0x' + '11'.repeat(20)) as Address
const otherWallet = ('0x' + '22'.repeat(20)) as Address

function source(name: ArcBalanceSource['name'], read: ArcBalanceSource['read'], attempts = 1): ArcBalanceSource {
  return { name, read, attempts }
}

test('primary browser RPC success is cached as a confirmed zero-capable balance', async () => {
  let calls = 0
  const reader = new ArcBalanceReader()
  const sources = [source('configured-rpc', async () => { calls += 1; return BigInt(0) })]
  const first = await reader.read(wallet, sources)
  const second = await reader.read(wallet, sources)
  assert.equal(first.value, BigInt(0))
  assert.equal(first.status, 'fresh')
  assert.equal(second.value, BigInt(0))
  assert.equal(calls, 1)
})

test('primary failure falls through to the official RPC', async () => {
  const order: string[] = []
  const reader = new ArcBalanceReader()
  const result = await reader.read(wallet, [
    source('configured-rpc', async () => { order.push('configured'); throw new Error('Failed to fetch') }),
    source('official-rpc', async () => { order.push('official'); return BigInt(12) }),
  ])
  assert.deepEqual(order, ['configured', 'official'])
  assert.equal(result.value, BigInt(12))
  assert.equal(result.source, 'official-rpc')
})

test('public RPC failure can recover through the Arc wallet provider', async () => {
  const reader = new ArcBalanceReader()
  const result = await reader.read(wallet, [
    source('official-rpc', async () => { throw new Error('Failed to fetch') }),
    source('wallet-provider', async () => BigInt(25)),
  ])
  assert.equal(result.value, BigInt(25))
  assert.equal(result.source, 'wallet-provider')
})

test('browser sources can recover through the server fallback', async () => {
  const reader = new ArcBalanceReader()
  const result = await reader.read(wallet, [
    source('configured-rpc', async () => { throw new Error('browser blocked') }),
    source('official-rpc', async () => { throw new Error('browser blocked') }),
    source('server-fallback', async () => BigInt(40)),
  ])
  assert.equal(result.value, BigInt(40))
  assert.equal(result.source, 'server-fallback')
})

test('all source failures remain unknown and never become zero', async () => {
  const reader = new ArcBalanceReader()
  const result = await reader.read(wallet, [source('official-rpc', async () => { throw new Error('offline') })])
  assert.equal(result.value, undefined)
  assert.equal(result.status, 'unknown')
})

test('last-known-good survives a forced refresh failure as stale', async () => {
  let now = 1_000
  const reader = new ArcBalanceReader({ now: () => now })
  await reader.read(wallet, [source('official-rpc', async () => BigInt(77))])
  now += 1
  const result = await reader.read(wallet, [source('official-rpc', async () => { throw new Error('offline') })], { force: true })
  assert.equal(result.value, BigInt(77))
  assert.equal(result.status, 'stale')
})

test('wallet keys isolate cached balances and invalidation marks only the selected wallet stale', async () => {
  let now = 2_000
  const reader = new ArcBalanceReader({ now: () => now })
  await reader.read(wallet, [source('official-rpc', async () => BigInt(5))])
  await reader.read(otherWallet, [source('official-rpc', async () => BigInt(9))])
  reader.invalidate(wallet)
  assert.equal(reader.snapshot(wallet).status, 'stale')
  assert.equal(reader.snapshot(otherWallet).status, 'fresh')
  assert.equal(reader.snapshot(otherWallet).value, BigInt(9))
})

test('simultaneous components share one in-flight balance request', async () => {
  let calls = 0
  let resolve!: (value: bigint) => void
  const pending = new Promise<bigint>(done => { resolve = done })
  const reader = new ArcBalanceReader()
  const sources = [source('official-rpc', async () => { calls += 1; return pending })]
  const first = reader.read(wallet, sources, { force: true })
  const second = reader.read(wallet, sources, { force: true })
  resolve(BigInt(15))
  assert.equal((await first).value, BigInt(15))
  assert.equal((await second).value, BigInt(15))
  assert.equal(calls, 1)
})

test('repeated source failures open a short circuit and prefer a healthy fallback', async () => {
  let now = 3_000
  let primaryCalls = 0
  const reader = new ArcBalanceReader({ now: () => now, failureThreshold: 2, cooldownMs: 500 })
  const sources = [
    source('configured-rpc', async () => { primaryCalls += 1; throw new Error('offline') }),
    source('official-rpc', async () => BigInt(primaryCalls)),
  ]
  await reader.read(wallet, sources, { force: true })
  now += 1
  await reader.read(wallet, sources, { force: true })
  now += 1
  const duringCooldown = await reader.read(wallet, sources, { force: true })
  assert.equal(primaryCalls, 2)
  assert.equal(duringCooldown.source, 'official-rpc')
  assert.ok(reader.sourceHealth('configured-rpc').cooldownUntil > now)
})

test('wrong-chain connectors do not offer the wallet provider as an Arc read source', () => {
  let providerRequests = 0
  const sources = arcBalanceSources({
    wallet,
    activeChainId: 8453,
    getWalletProvider: async () => ({
      request: async () => { providerRequests += 1; return '0x13b2' },
      on: () => undefined,
      removeListener: () => undefined,
    } as never),
    configuredRpcUrl: '',
    fetcher: async () => Response.json({ balance_raw: '0', chain_id: 5042 }),
  })
  assert.equal(sources.some(item => item.name === 'wallet-provider'), false)
  assert.equal(providerRequests, 0)
})

test('Arc wallet provider source verifies the provider chain before eth_call', async () => {
  const methods: string[] = []
  const sources = arcBalanceSources({
    wallet,
    activeChainId: 5042,
    getWalletProvider: async () => ({
      request: async ({ method }: { method: string }) => {
        methods.push(method)
        if (method === 'eth_chainId') return '0x13b2'
        if (method === 'eth_call') return `0x${BigInt(123).toString(16).padStart(64, '0')}`
        throw new Error(`Unexpected method ${method}`)
      },
      on: () => undefined,
      removeListener: () => undefined,
    } as never),
    configuredRpcUrl: '',
    fetcher: async () => Response.json({ balance_raw: '0', chain_id: 5042 }),
  })
  const provider = sources.find(item => item.name === 'wallet-provider')
  assert.equal(await provider?.read(wallet), BigInt(123))
  assert.deepEqual(methods, ['eth_chainId', 'eth_call'])
})

test('stale connector state cannot make a Base wallet provider perform an Arc eth_call', async () => {
  const methods: string[] = []
  const sources = arcBalanceSources({
    wallet,
    activeChainId: 5042,
    getWalletProvider: async () => ({
      request: async ({ method }: { method: string }) => { methods.push(method); return '0x2105' },
      on: () => undefined,
      removeListener: () => undefined,
    } as never),
    configuredRpcUrl: '',
    fetcher: async () => Response.json({ balance_raw: '0', chain_id: 5042 }),
  })
  const provider = sources.find(item => item.name === 'wallet-provider')
  await assert.rejects(() => provider!.read(wallet), /not on Arc/)
  assert.deepEqual(methods, ['eth_chainId'])
})

test('same-origin server source validates its normalized Arc response', async () => {
  let requested = ''
  const sources = arcBalanceSources({
    wallet,
    activeChainId: 8453,
    configuredRpcUrl: '',
    fetcher: async input => {
      requested = String(input)
      return Response.json({ balance_raw: '456', chain_id: 5042 })
    },
  })
  const server = sources.find(item => item.name === 'server-fallback')
  assert.equal(await server?.read(wallet), BigInt(456))
  assert.match(requested, /^\/api\/wallet\/arc-balance\?wallet=0x/)
})

test('configured and official duplicate URLs are de-duplicated', () => {
  const sources = arcBalanceSources({
    wallet,
    configuredRpcUrl: 'https://rpc.mainnet.arc.io',
    fetcher: async () => Response.json({ balance_raw: '0', chain_id: 5042 }),
  })
  assert.deepEqual(sources.map(item => item.name), ['configured-rpc', 'server-fallback'])
})
