import assert from 'node:assert/strict'
import test from 'node:test'
import { AcquisitionBudgetPause, mockCanaryAcquisitionDraft, processAcquisitionBatch, validAcquisitionDraft, type AcquisitionCandidate, type AcquisitionPort } from '../../src/lib/admin-worker/acquisition'

const candidate = (providerId: string, overrides: Partial<AcquisitionCandidate> = {}): AcquisitionCandidate => ({
  providerId, leadId: providerId, provider: providerId, product: 'Maps API', email: `${providerId}@example.com`,
  emailObserved: true, emailValid: true, evidenceVerified: true, recipientEligible: true,
  channelApproved: true, evidence: ['https://example.com/maps'], ...overrides,
})
const draft = { subject: 'Maps API on Mahshar', body: 'Hello. Maps API could join Mahshar, an API marketplace for AI agents, developers and individual users. Pay-per-call USDC on Arc. You choose which API to list through Seller onboarding.' }

function fixture(items: AcquisitionCandidate[]) {
  let running = true
  let dispatches = 0
  const queue = [...items]
  const history = new Set<string>()
  const reservations = new Set<string>()
  const outcomes: string[] = []
  const port: AcquisitionPort = {
    next: async () => queue.shift() ?? null,
    running: async () => running,
    priorOutreach: async id => history.has(id),
    draft: async () => draft,
    reserve: async item => {
      if (history.has(item.providerId) || !running) return null
      history.add(item.providerId)
      reservations.add(item.providerId)
      return item.providerId
    },
    dispatch: async () => { dispatches++; return `message-${dispatches}` },
    record: async (_item, outcome) => { outcomes.push(outcome) },
    delivered: async id => { reservations.delete(id) },
    ambiguous: async () => {},
  }
  return { port, history, reservations, outcomes, stop: () => { running = false }, get dispatches() { return dispatches } }
}

test('no email and ineligible contact advance to eligible provider', async () => {
  const f = fixture([candidate('a', { email: null }), candidate('b', { recipientEligible: false }), candidate('c')])
  assert.deepEqual(await processAcquisitionBatch(f.port, 3), ['no_email', 'recipient_ineligible', 'sent'])
  assert.equal(f.dispatches, 1)
})

test('provider history prevents a second initial invitation', async () => {
  const f = fixture([candidate('a'), candidate('a')])
  assert.deepEqual(await processAcquisitionBatch(f.port, 2), ['sent', 'prior_outreach'])
  assert.equal(f.dispatches, 1)
})

test('ambiguous dispatch leaves reservation and is never resent after restart', async () => {
  const f = fixture([candidate('a')])
  f.port.dispatch = async () => { throw new Error('timeout after send') }
  assert.deepEqual(await processAcquisitionBatch(f.port, 1), ['ambiguous_delivery'])
  assert.equal(f.reservations.has('a'), true)
  f.port.next = async () => candidate('a')
  assert.deepEqual(await processAcquisitionBatch(f.port, 1), ['prior_outreach'])
})

test('stop after draft prevents reservation and dispatch', async () => {
  const f = fixture([candidate('a')])
  f.port.draft = async () => { f.stop(); return draft }
  assert.deepEqual(await processAcquisitionBatch(f.port, 1), ['stopped'])
  assert.equal(f.dispatches, 0)
})

test('one provider failure does not block following provider', async () => {
  const f = fixture([candidate('a'), candidate('b')])
  f.port.draft = async item => { if (item.providerId === 'a') throw new Error('model unavailable'); return draft }
  assert.deepEqual(await processAcquisitionBatch(f.port, 2), ['provider_failed', 'sent'])
})

test('public address alone never authorizes the configured channel', async () => {
  const f = fixture([candidate('a', { channelApproved: false })])
  assert.deepEqual(await processAcquisitionBatch(f.port, 1), ['channel_not_approved'])
  assert.equal(f.dispatches, 0)
})

test('budget pause keeps the investigation available for resume', async () => {
  const f = fixture([candidate('a')])
  const original = f.port.next
  let pending: AcquisitionCandidate | null = null
  f.port.next = async () => pending ?? (pending = await original())
  f.port.draft = async () => { throw new AcquisitionBudgetPause() }
  assert.deepEqual(await processAcquisitionBatch(f.port, 1), [])
  assert.equal(f.dispatches, 0)
  f.port.draft = async () => draft
  assert.deepEqual(await processAcquisitionBatch(f.port, 1), ['sent'])
})

test('one-provider canary draft is grounded and requires no model adapter', () => {
  const item = candidate('canary', { provider: 'Fixture Provider', product: 'Weather API' })
  const result = mockCanaryAcquisitionDraft(item)
  assert.equal(validAcquisitionDraft(item, result), true)
  assert.match(result.subject, /^\[Simulation\]/)
  assert.match(result.body, /Weather API/)
  assert.doesNotMatch(result.body, /guarantee|existing partnership/i)
})
