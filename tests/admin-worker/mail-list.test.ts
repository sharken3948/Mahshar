import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { NextRequest } from 'next/server'
import { alice, bob, origin, reset, sessionHeaders } from '../marketplace/fixtures'
import { boundary } from '../admin/fixture'
import * as list from '../../src/app/api/admin/worker/mail-list/route'
import * as mark from '../../src/app/api/admin/worker/mail-list/[id]/mark-sent/route'
import { discoverApiDirectoryRange } from '../../src/lib/admin-worker/discovery/registry'
import { processDiscoveryCandidate, processDiscoveryRange } from '../../src/lib/admin-worker/discovery/processor'
import type { DurableCandidate } from '../../src/lib/admin-worker/discovery/types'

const id = '00000000-0000-4000-8000-000000000001'
const path = `/api/admin/worker/mail-list/${id}/mark-sent`
const context = { params: Promise.resolve({ id }) }
function request(url: string, method: 'GET' | 'POST', account?: typeof alice, override?: Record<string, string>) {
  return new NextRequest(origin + url, { method, headers: account ? { ...sessionHeaders(account), ...override } : override })
}
beforeEach(() => {
  reset(); boundary.rpcOverride = null; boundary.unavailable = false; boundary.external = 0
  process.env.ADMIN_WALLETS = alice.address
})

test('Pending Emails reads and manual mutations require the existing Admin session and origin protections', async () => {
  assert.equal((await list.GET(request('/api/admin/worker/mail-list', 'GET'))).status, 401)
  assert.equal((await list.GET(request('/api/admin/worker/mail-list', 'GET', bob))).status, 403)
  assert.equal((await mark.POST(request(path, 'POST'), context)).status, 403)
  assert.equal((await mark.POST(request(path, 'POST', bob), context)).status, 403)
  assert.equal((await mark.POST(request(path, 'POST', alice, { origin: 'https://other.example' }), context)).status, 403)
  assert.equal((await list.GET(request('/api/admin/worker/mail-list?after=invalid', 'GET', alice))).status, 400)
  assert.equal((await mark.POST(request(path, 'POST', alice), { params: Promise.resolve({ id: 'invalid' }) })).status, 400)
  assert.deepEqual(Object.keys(list).sort(), ['GET', 'runtime'])
  assert.deepEqual(Object.keys(mark).sort(), ['POST', 'runtime'])
})

test('authorized list and mark use only the manual registry RPCs, retain Admin identity, and refresh without transport', async () => {
  let sent = false; const calls: string[] = []
  boundary.rpcOverride = async (name, args) => {
    calls.push(name)
    if (name === 'mahshar_worker_mail_list') {
      assert.deepEqual(args, { p_after: null, p_limit: 25 })
      return { data: { items: sent ? [] : [{ id, apiName: 'Verified API', emailAddress: 'business@example.com' }], nextCursor: null }, error: null }
    }
    assert.equal(name, 'mahshar_worker_mail_mark_sent', 'No sending, reservation or delivery RPC is allowed')
    assert.deepEqual(args, { p_id: id, p_admin_wallet: alice.address.toLowerCase() })
    sent = true
    return { data: { id, status: 'manual_sent', manualSentAt: '2026-10-17T00:00:00Z' }, error: null }
  }
  const before = await list.GET(request('/api/admin/worker/mail-list', 'GET', alice))
  assert.equal(before.headers.get('Cache-Control'), 'no-store')
  assert.equal((await before.json()).items.length, 1)
  const results = await Promise.all([0, 1, 2].map(() => mark.POST(request(path, 'POST', alice), context)))
  for (const result of results) { assert.equal(result.status, 200); assert.equal((await result.json()).status, 'manual_sent') }
  const after = await list.GET(request('/api/admin/worker/mail-list', 'GET', alice))
  assert.deepEqual((await after.json()).items, [])
  assert.equal(boundary.external, 0)
  assert.ok(calls.every(name => name.startsWith('mahshar_worker_mail_')))
})

test('database failure and changed eligibility are explicit errors rather than successful manual sends', async () => {
  boundary.rpcOverride = async () => ({ data: null, error: { message: 'private database detail' } })
  assert.equal((await list.GET(request('/api/admin/worker/mail-list', 'GET', alice))).status, 503)
  const failed = await mark.POST(request(path, 'POST', alice), context)
  assert.equal(failed.status, 503); assert.doesNotMatch(JSON.stringify(await failed.json()), /private database detail/)
  boundary.rpcOverride = async () => ({ data: null, error: { message: 'mail_not_pending' } })
  assert.equal((await mark.POST(request(path, 'POST', alice), context)).status, 409)
})

test('known normalized identities are skipped before provider-detail fetch, including a new product name', async () => {
  const requested: string[] = []
  const result = await discoverApiDirectoryRange({
    rootRunNumber: 1, start: 0, end: 2,
    loadSourceWork: async key => key === 'providers:plan'
      ? { kind: 'provider_plan', providers: ['api.known.example', 'fresh.example'], sourceExhausted: true } : null,
    materializeSourceWork: async (_key, _kind, value) => value,
    providerHistory: async () => [{ domain: 'known.example', providerId: id, reason: 'manual_mail_history' }],
    fetcher: async url => {
      requested.push(url)
      return { status: 200, url, contentType: 'application/json', body: JSON.stringify({ apis: {
        product: { info: { title: 'Another Product API' }, swaggerUrl: 'https://fresh.example/openapi.json' },
      } }) }
    },
  })
  assert.equal(requested.length, 1); assert.match(requested[0], /fresh\.example/)
  assert.equal(result.items[0].reasonCode, 'provider_identity_processed')
  assert.equal(result.items[1].candidate?.discoveredDomain, 'fresh.example')
})

test('finalized identity preflight prevents official research and Groq even for saved pending candidates', async () => {
  boundary.rpcOverride = async name => {
    assert.equal(name, 'mahshar_worker_mail_discovery_state')
    return { data: [{ domain: 'known.example', provider_id: id, reason: 'manual_mail_history' }], error: null }
  }
  const candidate: DurableCandidate = {
    id, discoveryBatchId: id, ordinal: 0, sourceType: 'api_directory', sourceUrl: 'https://api.apis.guru/v2/known.example.json',
    discoveredName: 'Known', discoveredDomain: 'known.example', discoveredProduct: 'Different Product API',
    normalizedDomain: null, normalizedProductKey: null, status: 'pending', reasonCode: null,
    providerId: null, productId: null, leadId: null, retryAfter: null, processingLeaseId: null, processingLeaseExpiresAt: null,
  }
  const forbidden = async (): Promise<never> => { throw new Error('External research or inference forbidden') }
  const result = await processDiscoveryCandidate(id, candidate, Date.now() + 10000, {
    markDiscoveryCandidate: async () => {}, researchCandidate: forbidden, qualifyCandidate: forbidden,
  })
  assert.equal(result.status, 'blocked'); assert.equal(result.reasonCode, 'manual_mail_history')
})

test('historical CSV reconciliation is identity-based, repeatable, and never manufactures eligibility', async () => {
  const { reconcileShortlist, snapshotQuery } = await import('../../scripts/reconcile-pending-emails.mjs')
  // Business history stays in the separately reviewed import input. Unit tests
  // use synthetic contacts and do not require publishing the historical CSV.
  const csv = 'Company / Provider name,Official website,Verified business email,API product name,API documentation URL\n'
    + 'QuickChart,https://quickchart.io/,quickchart@fixture.example,Fixture API,https://quickchart.io/docs\n'
    + 'JSON2Video,https://json2video.com/,video@fixture.example,Fixture API,https://json2video.com/docs\n'
  const unknown = reconcileShortlist(csv)
  assert.equal(unknown.count, 2); assert.deepEqual(unknown.counts, { database_snapshot_required: 2 })
  assert.deepEqual(unknown.eligibleProviderIds, [])
  assert.match(snapshotQuery, /BEGIN TRANSACTION READ ONLY/)
  assert.match(snapshotQuery, /p_dry_run=>true/)
  const snapshot = { observedAt: '2026-10-17T00:00:00Z', readOnly: 'on' as const,
    providers: [{ id, domain: 'quickchart.io' }], identities: [],
    legacy: [{ id: 'legacy', url: 'https://json2video.com/', invited: false }],
    reconciliation: [{ providerId: id, eligible: true, reason: null, registryStatus: null }] }
  const report = reconcileShortlist(csv, snapshot)
  assert.deepEqual(report, reconcileShortlist(csv, snapshot))
  assert.deepEqual(report.eligibleProviderIds, [id])
  assert.equal(report.records.find(r => r.identity === 'json2video.com')?.disposition, 'legacy_requires_worker_evidence')
  const contacted = reconcileShortlist(csv, { ...snapshot, legacy: snapshot.legacy.map(item => ({ ...item, hasOutreachHistory: true })) })
  assert.equal(contacted.records.find(r => r.identity === 'json2video.com')?.disposition, 'legacy_contacted')
  assert.equal(contacted.legacyIntake.length, 0)
  snapshot.reconciliation[0].eligible = false
  assert.deepEqual(reconcileShortlist(csv, snapshot).eligibleProviderIds, [])
})

test('finalized mail skips contact research while a pending provider can recover missing contact evidence', async () => {
  let reason = 'manual_mail_history'; let research = 0
  const candidate = { id, providerId: id, leadId: id, normalizedDomain: 'known.example' } as DurableCandidate
  const dependencies = {
    recoverPendingEmails: async () => {}, claimMailRecoveryCandidates: async () => [],
    getProviderHistory: async () => [{ domain: 'known.example', providerId: id, reason }],
    getDiscoveryRunContext: async () => ({ batchId: id, rootRunNumber: 1, deadlineAt: new Date(Date.now() + 10000).toISOString(), qualifiedCount: 0, qualifiedTarget: 50 }),
    claimContactEnrichmentCandidates: async () => [candidate], getSavedContactResearch: async () => null,
    getReusableProvenance: async () => [], claimDeferredCandidates: async () => [], getDiscoveryCandidates: async () => [],
    discoverProviderContacts: async () => {
      research++
      return { status: 'verified_email' as const, emailReady: true, preferredEmail: 'business@known.example',
        preferredContactUrl: null, evidence: [], completed: true, failureCode: null }
    },
    saveContactResearch: async () => 'saved' as const,
    applyContactActionability: async () => ({ countedQualified: false, targetReached: false, blocked: false }),
  }
  await processDiscoveryRange(id, 0, 0, dependencies)
  assert.equal(research, 0)
  reason = 'manual_mail_pending'
  await processDiscoveryRange(id, 0, 0, dependencies)
  assert.equal(research, 1)
})

test('missing migration stops before context, budgets, source requests, candidate writes or checkpoint advancement', async () => {
  const { WorkerMailInfrastructureError } = await import('../../src/lib/admin-worker/discovery/provider-history')
  let actions = 0
  boundary.rpcOverride = async name => {
    assert.equal(name, 'mahshar_worker_mail_recover')
    return { data: null, error: { code: 'PGRST202', message: 'missing required RPC' } }
  }
  await assert.rejects(processDiscoveryRange(id, 0, 5, {
    getDiscoveryRunContext: async () => { actions++; throw new Error('must not read/advance context') },
    saveDiscoveryCandidate: async () => { actions++ },
    discoverApiDirectoryRange: async () => { actions++; throw new Error('must not fetch') },
    claimDiscoveryBudget: async () => { actions++; return 'claimed' },
  }), WorkerMailInfrastructureError)
  assert.equal(actions, 0)
})

test('history infrastructure failures escape the directory catch without terminal source records', async () => {
  const { WorkerMailInfrastructureError } = await import('../../src/lib/admin-worker/discovery/provider-history')
  let writes = 0
  await assert.rejects(processDiscoveryRange(id, 0, 5, {
    recoverPendingEmails: async () => {},
    getDiscoveryRunContext: async () => ({ batchId: id, rootRunNumber: 1, deadlineAt: new Date(Date.now() + 60000).toISOString(), qualifiedCount: 0, qualifiedTarget: 50 }),
    claimContactEnrichmentCandidates: async () => [], claimMailRecoveryCandidates: async () => [], claimDeferredCandidates: async () => [],
    getDiscoveryCandidates: async () => [],
    discoverApiDirectoryRange: async () => { throw new WorkerMailInfrastructureError('worker_provider_history_unavailable') },
    saveDiscoveryCandidate: async () => { writes++ },
  }), WorkerMailInfrastructureError)
  assert.equal(writes, 0)
})

test('incompatible or incomplete history RPC responses never become empty duplicate history', async () => {
  const { getProviderHistory, WorkerMailInfrastructureError } = await import('../../src/lib/admin-worker/discovery/provider-history')
  for (const data of [[], [{}], [{ domain: 'different.example', provider_id: null, reason: null }],
    [{ domain: 'known.example', provider_id: null, reason: 'incompatible_history_policy' }]]) {
    boundary.rpcOverride = async () => ({ data, error: null })
    await assert.rejects(getProviderHistory(['known.example']), WorkerMailInfrastructureError)
  }
})

test('retained legacy work uses the existing processor, remains resumable, and obeys Stop before the next provider', async () => {
  let running = true; const processed: string[] = []; const finished: string[] = []
  const retained = [0, 1].map(ordinal => ({ id: String(ordinal), status: 'pending', mailRecoveryKind: 'legacy' } as DurableCandidate))
  const dependencies = {
    recoverPendingEmails: async () => {},
    acquisition: { running: async () => running, afterProvider: async () => { running = false } },
    getDiscoveryRunContext: async () => ({ batchId: id, rootRunNumber: 1, deadlineAt: new Date(Date.now()+60000).toISOString(), qualifiedCount: 0, qualifiedTarget: 50 }),
    claimContactEnrichmentCandidates: async () => [], claimDeferredCandidates: async () => [], getDiscoveryCandidates: async () => [],
    claimMailRecoveryCandidates: async () => retained,
    finishMailRecovery: async (candidateId: string) => { finished.push(candidateId) },
    processDiscoveryCandidate: async (_run: string, candidate: DurableCandidate) => {
      processed.push(candidate.id)
      return { status: 'persisted' as const, reasonCode: 'qualified', discovered: 1, duplicate: 0, filtered: 0,
        qualified: 1, persisted: 1, reviewCandidate: 0, deferred: 0, tractionScored: 1 }
    },
  }
  const result = await processDiscoveryRange(id, 0, 0, dependencies)
  assert.deepEqual(processed, ['0']); assert.deepEqual(finished, ['0']); assert.equal(result.nextIndex, 0)
})

test('evidence refresh requires fresh owned documentation, respects budgets and never stamps failed research as verified', async () => {
  const { refreshMailIdentity } = await import('../../src/lib/admin-worker/discovery/mail-recovery')
  const candidate = { id, leadId: id, normalizedDomain: 'fixture.example', discoveredDocsUrl: 'https://fixture.example/docs' } as DurableCandidate
  let fetched = 0; let saved = 0
  const dependencies = {
    claim: async (_run: string, budget: string) => { assert.equal(budget, 'research'); return 'claimed' as const },
    save: async (_lead: string, facts: Array<{ checkedAt: string; sourceRole: string }>) => {
      saved++; assert.equal(facts[0].sourceRole,'official_docs'); assert.ok(Date.now()-Date.parse(facts[0].checkedAt)<10000)
    },
    fetcher: async (url: string) => { fetched++; return { url, status: 200, contentType: 'text/html', body: 'API reference: GET /api/weather Forecast API' } },
  }
  assert.equal(await refreshMailIdentity(id,candidate,undefined,dependencies),null)
  assert.equal(fetched,1); assert.equal(saved,1)
  fetched=0; saved=0
  assert.equal(await refreshMailIdentity(id,candidate,undefined,{...dependencies,claim:async()=> 'exhausted'}),'research_budget_exhausted')
  assert.equal(fetched,0); assert.equal(saved,0)
  assert.equal(await refreshMailIdentity(id,candidate,undefined,{...dependencies,
    fetcher:async url=>({url,status:503,contentType:'text/html',body:'Unavailable'})}),'official_docs_unreachable')
  assert.equal(saved,0)
  await assert.rejects(refreshMailIdentity(id,candidate,async()=>false,dependencies),/acquisition_stopped/)
  await assert.rejects(refreshMailIdentity(id,candidate,undefined,{...dependencies,save:async()=>{throw new Error('database unavailable')}}),/database unavailable/)
})

test('fresh work reaches the qualified target before any retained recovery claims', async () => {
  let legacyClaims = 0
  const result = await processDiscoveryRange(id, 0, 1, {
    recoverPendingEmails: async () => {},
    getDiscoveryRunContext: async () => ({ batchId: id, rootRunNumber: 1,
      deadlineAt: new Date(Date.now() + 60000).toISOString(), qualifiedCount: 49, qualifiedTarget: 50 }),
    getDiscoveryCandidates: async () => [{ id, ordinal: 0, status: 'pending' } as DurableCandidate],
    processDiscoveryCandidate: async () => ({ status: 'persisted', reasonCode: 'qualified', discovered: 1,
      duplicate: 0, filtered: 0, qualified: 1, persisted: 1, reviewCandidate: 0, deferred: 0, tractionScored: 1, targetReached: true }),
    claimMailRecoveryCandidates: async () => { legacyClaims++; return [] },
  })
  assert.equal(legacyClaims, 0); assert.equal(result.nextIndex, 1)
  assert.equal(result.outcomes.reduce((count, item) => count + item.discovered, 0), 1)
})

test('source database RPC failures remain infrastructure errors even after the initial readiness check', async () => {
  const { materializeSourceWork } = await import('../../src/lib/admin-worker/discovery/repository')
  const { WorkerMailInfrastructureError } = await import('../../src/lib/admin-worker/discovery/provider-history')
  let writes=0
  boundary.rpcOverride=async name=>{
    assert.equal(name,'mahshar_worker_materialize_source_work')
    return {data:null,error:{code:'PGRST202',message:'required source RPC unavailable'}}
  }
  await assert.rejects(processDiscoveryRange(id,0,5,{
    recoverPendingEmails:async()=>{},claimContactEnrichmentCandidates:async()=>[],claimMailRecoveryCandidates:async()=>[],claimDeferredCandidates:async()=>[],
    getDiscoveryRunContext:async()=>({batchId:id,rootRunNumber:1,deadlineAt:new Date(Date.now()+60000).toISOString(),qualifiedCount:0,qualifiedTarget:50}),
    getDiscoveryCandidates:async()=>[],saveDiscoveryCandidate:async()=>{writes++},
    discoverApiDirectoryRange:async()=>{await materializeSourceWork(id,'providers:plan','provider_plan',{});throw new Error('unreachable')},
  }),WorkerMailInfrastructureError)
  assert.equal(writes,0)
})

test('durable contact recovery bypasses cached email-ready evidence and uses fresh contact verification', async () => {
  const candidate={id,providerId:id,productId:id,leadId:id,normalizedDomain:'fixture.example',mailRecoveryKind:'contact'} as DurableCandidate
  let verified=0;let saved=0;let finished=0
  const result=await processDiscoveryRange(id,0,0,{
    recoverPendingEmails:async()=>{},claimContactEnrichmentCandidates:async()=>[candidate],
    claimDeferredCandidates:async()=>[],claimMailRecoveryCandidates:async()=>[],getDiscoveryCandidates:async()=>[],
    getDiscoveryRunContext:async()=>({batchId:id,rootRunNumber:1,deadlineAt:new Date(Date.now()+60000).toISOString(),qualifiedCount:0,qualifiedTarget:50}),
    getReusableProvenance:async()=>[{sourceType:'website',sourceRole:'official_docs',url:'https://fixture.example/docs',checkedAt:new Date().toISOString()}],
    getSavedContactResearch:async()=>{throw new Error('Stale or inappropriate email-ready cache must not be reused')},
    discoverProviderContacts:async()=>{verified++;return {status:'verified_email',emailReady:true,preferredEmail:'business@fixture.example',preferredContactUrl:null,evidence:[],completed:true,failureCode:null}},
    saveContactResearch:async()=>{saved++;return 'saved'},
    applyContactActionability:async()=>({countedQualified:true,targetReached:false,blocked:false}),
    finishMailRecovery:async()=>{finished++},
  })
  assert.deepEqual([verified,saved,finished],[1,1,1]);assert.equal(result.nextIndex,0)
  assert.equal(result.outcomes[0].discovered,0)
})


test('only confirmed transaction aborts receive bounded idempotent mail RPC retries', async () => {
  const { workerMailRpc } = await import('../../src/lib/admin-worker/mail-list-rpc')
  let calls = 0
  boundary.rpcOverride = async () => ++calls < 3
    ? { data: null, error: { code: '55P03' } } : { data: { status: 'manual_sent' }, error: null }
  assert.equal((await workerMailRpc('mahshar_worker_mail_mark_sent', { p_id: id, p_admin_wallet: alice.address })).error, null)
  assert.equal(calls, 3)
  calls = 0
  boundary.rpcOverride = async () => { calls++; return { data: null, error: { code: '57014' } } }
  assert.equal((await workerMailRpc('mahshar_worker_mail_recover', { p_run_id: id })).error?.code, '57014')
  assert.equal(calls, 3)
  for (const code of ['PGRST202', '42P01', 'HTTP_TIMEOUT', 'FETCH_ERROR']) {
    calls = 0
    boundary.rpcOverride = async () => { calls++; return { data: null, error: { code } } }
    await workerMailRpc('mahshar_worker_mail_claim_recovery', { p_run_id: id, p_kind: 'legacy' })
    assert.equal(calls, 1, 'Missing schema and unknown commit outcomes must escape unchanged')
  }
  await assert.rejects(workerMailRpc('mahshar_admin_outreach_begin_transport' as never, {}), /not_retryable/)
  assert.equal(boundary.external, 0)
})

test('reconciliation checkpoints only after the provider transaction and safely replays a lost checkpoint', async () => {
  const { recoverPendingEmails } = await import('../../src/lib/admin-worker/discovery/repository')
  const calls: string[] = []
  let fail = true
  boundary.rpcOverride = async (name, args) => {
    calls.push(name)
    if (name === 'mahshar_worker_mail_recover') {
      assert.deepEqual(args, { p_run_id: id, p_limit: 25 })
      return { data: { processed: 25, cursorBefore: null, cursorAfter: id }, error: null }
    }
    assert.equal(name, 'mahshar_worker_mail_checkpoint_recovery')
    assert.deepEqual(args, { p_run_id: id, p_before: null, p_after: id })
    return fail ? { data: null, error: { code: 'FETCH_ERROR' } } : { data: true, error: null }
  }
  await assert.rejects(recoverPendingEmails(id), /checkpoint_unavailable/)
  fail = false
  await recoverPendingEmails(id)
  assert.deepEqual(calls, ['mahshar_worker_mail_recover','mahshar_worker_mail_checkpoint_recovery',
    'mahshar_worker_mail_recover','mahshar_worker_mail_checkpoint_recovery'])
  boundary.rpcOverride = async () => ({ data: 0, error: null })
  await assert.rejects(recoverPendingEmails(id), /infrastructure_unavailable/)
})
