import assert from 'node:assert/strict'
import test, { beforeEach, afterEach } from 'node:test'
import { budgetedCompletion } from '../../src/lib/groq-completion'
import { groq } from '../../src/lib/groq-neutral'
import { privateResourceScope, reserveResource, resourceLimit, ResourceBudgetError } from '../../src/lib/resource-budget'
import { createDiscoveryClient, DiscoverySourceError } from '../../src/lib/mcp/discovery-client'
import { resourceAdmission } from '../../src/lib/resource-admission'
import { enableTestBudgets, disableTestBudgets } from './policy-fixture'
import { state } from './database'

beforeEach(enableTestBudgets)
afterEach(disableTestBudgets)

const input = { model: 'offline-model', messages: [{ role: 'user' as const, content: 'test' }] }
function reset() { state.calls = []; state.allowed = true; state.failure = false; state.releases = 0 }

test('all features reserve shared budgets before inference, cap output and release once', async () => {
  const original = groq.chat.completions.create
  try {
    let providers = 0
    groq.chat.completions.create = (async (parameters: { max_completion_tokens: number; max_tokens?: number }) => {
      assert.equal(state.calls.at(-1)?.name, 'mahshar_reserve_resource')
      assert.equal(parameters.max_completion_tokens, 8192)
      assert.equal(parameters.max_tokens, undefined)
      providers++
      return { choices: [{ message: { content: '{}' } }] }
    }) as unknown as typeof original
    for (const feature of ['match', 'score', 'background'] as const) {
      reset()
      await budgetedCompletion(feature, { ...input, max_tokens: 32_000 })
      const reservation = state.calls[0].args
      assert.equal(reservation.p_lease_scope, 'groq:all')
      assert.equal(reservation.p_concurrency, 8)
      assert.equal((reservation.p_buckets as Array<{ scope: string }>)[2].scope, `groq:${feature}:day`)
      assert.ok(Number(reservation.p_units) >= 8192)
      assert.equal(state.releases, 1)
    }
    assert.equal(providers, 3)
  } finally { groq.chat.completions.create = original }
})

test('denied or unavailable budgets do not call provider; missing configuration fails closed', async () => {
  const original = groq.chat.completions.create
  let providers = 0
  groq.chat.completions.create = (async () => { providers++; throw new Error('unexpected provider') }) as unknown as typeof original
  try {
    reset(); state.allowed = false
    await assert.rejects(budgetedCompletion('match', input), (e: unknown) => e instanceof ResourceBudgetError && !e.unavailable)
    reset(); state.failure = true
    await assert.rejects(budgetedCompletion('score', input), (e: unknown) => e instanceof ResourceBudgetError && e.unavailable)
    assert.equal(providers, 0)
    process.env.MAHSHAR_GROQ_REQUESTS_DAY = '0'
    assert.throws(() => resourceLimit('MAHSHAR_GROQ_REQUESTS_DAY', 2000), ResourceBudgetError)
  } finally { delete process.env.MAHSHAR_GROQ_REQUESTS_DAY; groq.chat.completions.create = original; reset() }
})

test('provider failures release capacity without refunding consumed reservations', async () => {
  const original = groq.chat.completions.create
  reset()
  groq.chat.completions.create = (async () => { throw new Error('offline provider timeout') }) as unknown as typeof original
  try {
    await assert.rejects(budgetedCompletion('score', input), /offline provider timeout/)
    assert.equal(state.releases, 1)
    assert.deepEqual(state.calls.map(call => call.name), ['mahshar_reserve_resource', 'mahshar_release_resource'])
  } finally { groq.chat.completions.create = original }
})

test('oversized prompts are rejected before database and provider requests', async () => {
  reset()
  await assert.rejects(budgetedCompletion('match', { ...input, messages: [{ role: 'user', content: 'x'.repeat(150_000) }] }), ResourceBudgetError)
  assert.equal(state.calls.length, 0)
})

test('wallet rotation cannot alter the shared admission scope, and wallet keys are hashed', () => {
  const scope = privateResourceScope('listing-create:wallet', '0xABC')
  assert.equal(scope, privateResourceScope('listing-create:wallet', '0xabc'))
  assert.ok(!scope.includes('0xabc'))
})

test('release is idempotent and release failure does not hide successful work', async () => {
  reset()
  const release = await reserveResource({ buckets: [{ scope: 'test', window_seconds: 60, request_limit: 5, unit_limit: 100 }], leaseScope: 'test', concurrency: 1 })
  await release(); await release()
  assert.equal(state.releases, 1)
  const failureRelease = await reserveResource({ buckets: [{ scope: 'test', window_seconds: 60, request_limit: 5, unit_limit: 100 }], leaseScope: 'test', concurrency: 1 })
  state.failure = true
  await failureRelease()
  reset()
})

test('disabled policies preserve exact SDK inputs and do not query the budget database under concurrent normal work', async () => {
  disableTestBudgets(); reset(); state.failure = true
  const original = groq.chat.completions.create
  let calls = 0
  const originalInput = { ...input, max_tokens: 32_000, messages: [{ role: 'user' as const, content: 'x'.repeat(150_000) }] }
  groq.chat.completions.create = (async parameters => {
    assert.equal(parameters, originalInput)
    calls++
    return { choices: [{ message: { content: '{}' } }] }
  }) as typeof original
  try {
    await Promise.all(Array.from({ length: 60 }, (_, i) => budgetedCompletion((['match', 'score', 'background'] as const)[i % 3], originalInput)))
    assert.equal(calls, 60)
    assert.equal(state.calls.length, 0)
    for (const kind of ['listing-create', 'verification', 'onramp'] as const) {
      assert.equal((await resourceAdmission(kind, '0xabc')).response, null)
    }
    assert.equal(state.calls.length, 0)
  } finally { groq.chat.completions.create = original; reset() }
})

test('opt-in requires explicit ceilings and never uses the old uncalibrated defaults', async () => {
  reset()
  delete process.env.MAHSHAR_GROQ_REQUESTS_MINUTE
  await assert.rejects(budgetedCompletion('match', input), e => e instanceof ResourceBudgetError && e.unavailable)
  assert.equal(state.calls.length, 0)
  delete process.env.MAHSHAR_ONRAMP_WALLET_DAY
  assert.equal((await resourceAdmission('onramp', '0xabc')).response?.status, 503)
  assert.equal(state.calls.length, 0)
})

test('lease release has a deadline, cancels transport and cannot hide completed work', async () => {
  let releaseSignal: AbortSignal | undefined
  let releases = 0
  const never = new Promise<{ data: unknown; error: unknown }>(() => {})
  const database = { rpc: (name: string) => {
    if (name === 'mahshar_reserve_resource') return Promise.resolve({ data: [{ allowed: true, lease_id: 'lease' }], error: null })
    releases++
    return Object.assign(never, { abortSignal: (signal: AbortSignal) => { releaseSignal = signal; return never } })
  } }
  const release = await reserveResource({ buckets: [], leaseScope: 'test', concurrency: 1, database })
  const started = performance.now()
  const completed = await (async () => { try { return 'completed provider response' } finally { await release() } })()
  assert.equal(completed, 'completed provider response')
  assert.ok(performance.now() - started < 1500)
  assert.equal(releaseSignal?.aborted, true)
  await release()
  assert.equal(releases, 1)
})

test('stalled budget reservation is canceled and fails closed within its operational deadline', async () => {
  let signal: AbortSignal | undefined
  const never = new Promise<{ data: unknown; error: unknown }>(() => {})
  const started = performance.now()
  await assert.rejects(reserveResource({ buckets: [], database: { rpc: () => Object.assign(never, {
    abortSignal: (value: AbortSignal) => { signal = value; return never },
  }) } }), e => e instanceof ResourceBudgetError && e.unavailable)
  assert.equal(signal?.aborted, true)
  assert.ok(performance.now() - started < 4000)
})

test('local MCP discovery times out even if a loader ignores cancellation', async () => {
  let signal: AbortSignal | undefined
  const started = performance.now()
  const client = createDiscoveryClient({ origin: 'https://offline.invalid', timeoutMs: 10, loadPage: (_url, value) => {
    signal = value
    return new Promise<Response>(() => {})
  } })
  await assert.rejects(client.page(10, 0), DiscoverySourceError)
  assert.equal(signal?.aborted, true)
  assert.ok(performance.now() - started < 1000)
})

test('MCP deadline also bounds and cancels a stalled response body', async () => {
  let canceled = false
  const client = createDiscoveryClient({ origin: 'https://offline.invalid', timeoutMs: 10, loadPage: async () => new Response(new ReadableStream({
    start() {}, cancel() { canceled = true },
  })) })
  await assert.rejects(client.page(10, 0), DiscoverySourceError)
  assert.equal(canceled, true)
})
