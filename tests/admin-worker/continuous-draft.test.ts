import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { boundary } from '../admin/fixture'
import { state, reset } from '../marketplace/fixtures'
import { groq } from '../../src/lib/groq-neutral'
import { acquisitionPort } from '../../src/lib/admin-worker/acquisition-runtime'
import { AcquisitionBudgetPause, AcquisitionPreparationSkip, mockCanaryAcquisitionDraft, processAcquisitionBatch, type AcquisitionCandidate } from '../../src/lib/admin-worker/acquisition'
import { documentationFact, hasDraftDocumentation, invitationEvidence, type DraftEvidenceContext } from '../../src/lib/admin-worker/acquisition-evidence'

const saved = JSON.parse(readFileSync(new URL('./fixtures/acquisition-provider-saved.json', import.meta.url), 'utf8')).providers as {
  domain: string; product: string; email: string; identityUrl: string; contractUrl: string; contractSummary: string
  officialPage: { url: string; body: string }
}[]
const at = '2026-10-15T11:31:00Z'
function candidate(provider = saved[0], withDocs = true): AcquisitionCandidate {
  const context: DraftEvidenceContext = { key: 'evidence-key', domain: provider.domain, allowed: true, identityVerified: true, contactVerified: true,
    docsUrls: [], facts: [
      { sourceType: 'website', sourceRole: 'official_site', url: provider.identityUrl, factualSummary: 'Provider-owned site independently verified for this directory contract.', checkedAt: at },
      { sourceType: 'api_directory', sourceRole: 'directory_assertion', url: provider.contractUrl, factualSummary: provider.contractSummary, checkedAt: at },
    ] }
  const doc = documentationFact(provider.officialPage.url, provider.officialPage.body, provider.domain, at)
  if (withDocs && doc) context.facts.unshift(doc)
  return { attemptId: 'attempt', claimToken: 'lease', providerId: provider.domain, leadId: 'lead',
    provider: provider.domain, product: provider.product, email: provider.email, emailObserved: true,
    emailValid: true, evidenceVerified: true, recipientEligible: false, channelApproved: false,
    draftContext: context, evidence: invitationEvidence(context) }
}

async function offline(action: (events: string[], item: AcquisitionCandidate) => Promise<void>) {
  const oldCreate = groq.chat.completions.create
  const keys = ['GROQ_API_KEY', 'ADMIN_ACQUISITION_MODE', 'ADMIN_ACQUISITION_CONTINUOUS', 'ADMIN_ACQUISITION_CANARY']
  const previous = keys.map(key => process.env[key]); reset()
  const item = candidate(), events: string[] = []
  process.env.GROQ_API_KEY = 'synthetic-offline-fixture'
  process.env.ADMIN_ACQUISITION_MODE = 'true'; process.env.ADMIN_ACQUISITION_CONTINUOUS = 'true'; process.env.ADMIN_ACQUISITION_CANARY = 'false'
  state.tables.worker_control = [{ id: 1, desired_state: 'running' }]
  state.tables.admin_acquisition_control = [{ id: 1, desired_state: 'running', epoch: 'epoch' }]
  state.tables.worker_runs = [{ id: 'run', status: 'running' }]; state.tables.admin_outreach_threads = []
  boundary.rpcOverride = async (name, args) => {
    events.push(name)
    if (name === 'mahshar_worker_claim_budget_v2') return { data: 'claimed', error: null }
    if (name === 'mahshar_acquisition_draft_context') return { data: item.draftContext, error: null }
    assert.equal(name, 'mahshar_acquisition_save_draft_only')
    assert.equal(args.p_generator, 'groq'); assert.equal(args.p_evidence_key, item.draftContext!.key)
    assert.equal(args.p_claim_token, 'lease'); return { data: true, error: null }
  }
  groq.chat.completions.create = (async () => { events.push('offline-groq'); return { choices: [{ message: { content: JSON.stringify(mockCanaryAcquisitionDraft(item)) } }] } }) as unknown as typeof oldCreate
  try { await action(events, item) } finally {
    groq.chat.completions.create = oldCreate; boundary.rpcOverride = null
    keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i] })
  }
}

test('all four saved providers need official docs; three official excerpts satisfy grounding without relabeling directory contracts', () => {
  for (const provider of saved) {
    assert.equal(hasDraftDocumentation(candidate(provider, false).draftContext!), false)
    const item = candidate(provider)
    assert.equal(hasDraftDocumentation(item.draftContext!), provider.domain !== 'ideaconsult.net')
    if (item.evidence.length) {
      assert.ok(item.evidence.some(value => JSON.parse(value).role === 'directory_assertion'))
      assert.ok(item.evidence.some(value => JSON.parse(value).role === 'official_docs'))
      assert.ok(!item.evidence.some(value => JSON.parse(value).role === 'official_docs' && JSON.parse(value).url.includes('apis.guru')))
    }
  }
})

test('draft-only coordinator ignores dispatch eligibility, checkpoints Groq and never reserves or dispatches', async () => offline(async (events, item) => {
  const port = acquisitionPort('run', 'epoch'); let used = false
  port.next = async () => used ? null : (used = true, item)
  assert.deepEqual(await processAcquisitionBatch(port, 10), ['prepared'])
  assert.deepEqual(events, ['mahshar_acquisition_draft_context', 'mahshar_worker_claim_budget_v2', 'offline-groq', 'mahshar_acquisition_save_draft_only'])
  await assert.rejects(port.reserve(item, mockCanaryAcquisitionDraft(item)), /draft_only/)
  await assert.rejects(port.dispatch('no-reservation', item, mockCanaryAcquisitionDraft(item)), /draft_only/)
}))

test('three real provider examples use fenced provenance and grounded English offline Groq responses', async () => offline(async events => {
  for (const provider of saved.filter(value => value.domain !== 'ideaconsult.net')) {
    const item = candidate(provider), expected = mockCanaryAcquisitionDraft(item)
    groq.chat.completions.create = (async (args: { messages: unknown[] }) => {
      const prompt = JSON.stringify(args.messages)
      assert.match(prompt, /untrusted/); assert.ok(prompt.includes(item.product)); assert.match(prompt, /directory_assertion/)
      return { choices: [{ message: { content: JSON.stringify(expected) } }] }
    }) as unknown as typeof groq.chat.completions.create
    boundary.rpcOverride = async name => {
      events.push(name)
      if (name === 'mahshar_acquisition_draft_context') return { data: item.draftContext, error: null }
      if (name === 'mahshar_worker_claim_budget_v2') return { data: 'claimed', error: null }
      assert.equal(name, 'mahshar_acquisition_save_draft_only'); return { data: true, error: null }
    }
    assert.deepEqual(await acquisitionPort('run', 'epoch').draft(item), expected)
  }
}))

test('identity, contact, insufficient docs, Stop and exhausted budget prevent Groq', async () => offline(async (events, item) => {
  const port = acquisitionPort('run', 'epoch')
  for (const key of ['identityVerified', 'contactVerified'] as const) {
    item.draftContext![key] = false
    await assert.rejects(port.draft(item), AcquisitionPreparationSkip)
    item.draftContext![key] = true
  }
  assert.ok(!events.includes('offline-groq'))
  item.draftContext!.facts = []; item.draftContext!.docsUrls = []
  await assert.rejects(port.draft(item), /api_documentation_missing/)
  item.draftContext = candidate().draftContext
  item.draftContext!.allowed = false
  await assert.rejects(port.draft(item), /provider_suppressed/)
  item.draftContext!.allowed = true
  state.tables.worker_control[0].desired_state = 'stopped'
  await assert.rejects(port.draft(item), AcquisitionBudgetPause)
  state.tables.worker_control[0].desired_state = 'running'
  boundary.rpcOverride = async name => ({ data: name === 'mahshar_acquisition_draft_context' ? item.draftContext : 'exhausted', error: null })
  await assert.rejects(port.draft(item), AcquisitionBudgetPause)
  assert.ok(!events.includes('offline-groq'))
}))

test('invalid/malformed output and rate limits never receive Groq provenance', async () => offline(async (events, item) => {
  const port = acquisitionPort('run', 'epoch')
  for (const content of [JSON.stringify({ subject: 'Invalid', body: 'Ungrounded' }), 'invalid JSON']) {
    events.length = 0
    groq.chat.completions.create = (async () => ({ choices: [{ message: { content } }] })) as unknown as typeof groq.chat.completions.create
    if (content === 'invalid JSON') await assert.rejects(port.draft(item), SyntaxError)
    else await port.draft(item)
    assert.ok(!events.includes('mahshar_acquisition_save_draft_only'))
  }
  groq.chat.completions.create = (async () => { throw { status: 429 } }) as unknown as typeof groq.chat.completions.create
  await assert.rejects(port.draft(item), AcquisitionBudgetPause)
}))

test('rejected/ambiguous checkpoints pause; canary remains mock with no Groq calls', async () => offline(async (events, item) => {
  const original = boundary.rpcOverride!
  for (const lost of [false, true]) {
    boundary.rpcOverride = async (name, args) => {
      if (name === 'mahshar_acquisition_save_draft_only') {
        if (lost) throw new Error('lost checkpoint response')
        return { data: false, error: null }
      }
      return original(name, args)
    }
    await assert.rejects(acquisitionPort('run', 'epoch').draft(item), AcquisitionBudgetPause)
  }
  events.length = 0
  assert.deepEqual(await acquisitionPort('run', 'epoch', true).draft(item), mockCanaryAcquisitionDraft(item))
  assert.deepEqual(events, [])
}))
