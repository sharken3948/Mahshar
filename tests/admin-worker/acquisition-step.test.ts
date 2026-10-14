import assert from 'node:assert/strict'
import test from 'node:test'
import { processDiscoveryChunkStep } from '../../src/lib/admin-worker/workflow-steps'
import { processAcquisitionBatch, type AcquisitionCandidate, type AcquisitionPort } from '../../src/lib/admin-worker/acquisition'
import type { WorkerRunDto } from '../../src/lib/admin-worker/types'

test('Workflow chunk orders discovery, contact eligibility, mocked Groq, reservation, simulated send, and checkpoint', async () => {
  const events: string[] = []
  const base: AcquisitionCandidate = { providerId: 'eligible', leadId: 'eligible-lead', provider: 'Eligible',
    product: 'Maps API', email: 'business@example.com', emailObserved: true, emailValid: true,
    evidenceVerified: true, recipientEligible: true, channelApproved: true,
    evidence: ['https://example.com/maps/docs'] }
  const candidates = [{ ...base, providerId: 'no-email', email: null, emailObserved: false,
    emailValid: false, evidenceVerified: false, recipientEligible: false, channelApproved: false }, base]
  const history = new Set<string>()
  const port: AcquisitionPort = {
    running: async () => true,
    next: async () => candidates.shift() ?? null,
    priorOutreach: async id => history.has(id),
    draft: async item => { events.push(`groq:${item.product}`); return {
      subject: 'Maps API on Mahshar',
      body: 'Maps API could join Mahshar, an API marketplace for AI agents, developers and individual users. Pay-per-call USDC on Arc. You choose an API to list through Seller onboarding.',
    } },
    reserve: async item => { events.push(`reserve:${item.providerId}`); history.add(item.providerId); return 'durable-reservation' },
    dispatch: async () => { events.push('mock-send'); return 'simulated-message' },
    delivered: async (_id, messageId) => { events.push(`delivery:${messageId}`) },
    ambiguous: async () => { throw new Error('unexpected ambiguity') },
    record: async (_item, outcome) => { events.push(`outcome:${outcome}`) },
  }
  const run = await processDiscoveryChunkStep('run', { version: 1, nextIndex: 0, batchSize: 300 }, 'epoch', {
    discover: async () => { events.push('discovery:official-contact'); return {
      outcomes: [], nextIndex: 10, sourceExhausted: false, deadlineReached: false, hardLimitReached: false,
    } },
    acquire: async () => { await processAcquisitionBatch(port, 10) },
    advance: async (_id, from, to) => {
      assert.equal(from, 0); assert.equal(to, 10)
      events.push('checkpoint:10')
      return { checkpoint: { version: 1, nextIndex: 10, batchSize: 300 } } as WorkerRunDto
    },
  })
  assert.equal(run.checkpoint.nextIndex, 10)
  assert.deepEqual(events, ['discovery:official-contact', 'outcome:no_email', 'groq:Maps API',
    'reserve:eligible', 'mock-send', 'delivery:simulated-message', 'outcome:sent', 'checkpoint:10'])
})
