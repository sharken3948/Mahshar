import assert from 'node:assert/strict'
import { test } from 'node:test'
import { processDiscoveryRange } from '../../src/lib/admin-worker/discovery/processor'
import { boundedDiscoveryFetch } from '../../src/lib/admin-worker/discovery/fetch'
import { mockCanaryAcquisitionDraft, processAcquisitionBatch, type AcquisitionCandidate, type AcquisitionPort } from '../../src/lib/admin-worker/acquisition'
import type { DurableCandidate } from '../../src/lib/admin-worker/discovery/types'

test('research and mocked qualification/drafting/delivery finish for each provider before the next investigation', async () => {
  const events: string[] = []; let pending: AcquisitionCandidate | null = null; let running = true
  const delivered = new Set<string>()
  const port: AcquisitionPort = {
    running: async () => running, next: async () => { const item = pending; pending = null; return item },
    priorOutreach: async id => delivered.has(id), draft: async item => { events.push('draft:' + item.providerId); return mockCanaryAcquisitionDraft(item) },
    reserve: async item => { delivered.add(item.providerId); events.push('reserve:' + item.providerId); return item.providerId },
    dispatch: async id => { events.push('simulate:' + id); return 'simulated:' + id },
    delivered: async () => {}, ambiguous: async () => { throw new Error('unexpected') },
    record: async (_item, outcome) => { events.push(outcome) },
  }
  const candidates = [0, 1].map(ordinal => ({ ordinal, id: String(ordinal), status: 'pending' } as DurableCandidate))
  const dependencies = {
    acquisition: { running: async () => running, afterProvider: async () => { await processAcquisitionBatch(port, 1) } },
    getDiscoveryRunContext: async () => ({ batchId: 'existing-batch', rootRunNumber: 1,
      deadlineAt: new Date(Date.now() + 60000).toISOString(), qualifiedCount: 0, qualifiedTarget: 50 }),
    getDiscoveryCandidates: async () => candidates,
    processDiscoveryCandidate: async (_run: string, item: DurableCandidate) => {
      events.push('research-qualify-contact:' + item.id)
      pending = { providerId: item.id, leadId: item.id, provider: 'Fixture', product: 'Weather API',
        email: item.ordinal ? 'business@example.com' : null, emailObserved: Boolean(item.ordinal),
        emailValid: true, evidenceVerified: true, recipientEligible: true, channelApproved: true,
        evidence: ['https://example.com/docs'] }
      return { status: 'persisted' as const, reasonCode: 'qualified', discovered: 1, duplicate: 0,
        filtered: 0, qualified: 1, persisted: 1, reviewCandidate: 0, deferred: 0, tractionScored: 1 }
    },
  }
  const result = await processDiscoveryRange('run', 0, 2, dependencies)
  assert.equal(result.nextIndex, 2)
  assert.deepEqual(events, ['research-qualify-contact:0', 'no_email', 'research-qualify-contact:1',
    'draft:1', 'reserve:1', 'simulate:1', 'sent'])
  events.length = 0
  dependencies.acquisition.afterProvider = async () => { running = false }
  const stopped = await processDiscoveryRange('run', 0, 2, dependencies)
  assert.equal(stopped.nextIndex, 1)
  assert.deepEqual(events, ['research-qualify-contact:0'])
})

test('Stop between redirects prevents the next research request', async () => {
  let running = true; const requests: string[] = []
  await assert.rejects(boundedDiscoveryFetch('https://example.com/docs', {
    beforeRequest: async () => { if (!running) throw new Error('stopped') },
  }, async url => {
    requests.push(url); running = false
    return new Response(null, { status: 302, headers: { location: '/second' } })
  }), /stopped/)
  assert.deepEqual(requests, ['https://example.com/docs'])
})
