import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { boundary } from '../admin/fixture'
import { state, reset } from '../marketplace/fixtures'
import { groq } from '../../src/lib/groq-neutral'
import { acquisitionPort } from '../../src/lib/admin-worker/acquisition-runtime'
import { AcquisitionBudgetPause, AcquisitionPreparationSkip, mockCanaryAcquisitionDraft, processAcquisitionBatch, type AcquisitionCandidate } from '../../src/lib/admin-worker/acquisition'
import { renderInvitationTemplate, INVITATION_TEMPLATE_VERSION, type InvitationVariables } from '../../src/lib/admin-worker/invitation-template'

const providers = JSON.parse(readFileSync(new URL('./fixtures/acquisition-provider-saved.json', import.meta.url), 'utf8')).providers as { domain: string; product: string; email: string }[]
const variables = (): InvitationVariables => ({ company: 'Acme', product: 'Maps API', companyVerified: true, productVerified: true })
const context = () => ({ key: 'evidence-key', domain: 'acme.example', allowed: true, identityVerified: true, contactVerified: true,
  facts: [], docsUrls: [], templateVariables: variables() })
function candidate(): AcquisitionCandidate { return { attemptId: 'attempt', claimToken: 'lease', providerId: 'provider', leadId: 'lead',
  provider: 'Acme', product: 'Maps API', email: 'team@acme.example', emailObserved: true, emailValid: true,
  evidenceVerified: true, recipientEligible: false, channelApproved: false, evidence: [], templateVariables: variables() } }

async function offline(action: (events: string[], item: AcquisitionCandidate, saved: ReturnType<typeof context>) => Promise<void>) {
  const original = groq.chat.completions.create
  const keys = ['GROQ_API_KEY', 'ADMIN_ACQUISITION_MODE', 'ADMIN_ACQUISITION_CONTINUOUS', 'ADMIN_ACQUISITION_CANARY']
  const previous = keys.map(key => process.env[key]); reset()
  delete process.env.GROQ_API_KEY
  process.env.ADMIN_ACQUISITION_MODE = 'true'; process.env.ADMIN_ACQUISITION_CONTINUOUS = 'true'; process.env.ADMIN_ACQUISITION_CANARY = 'false'
  state.tables.worker_control = [{ id: 1, desired_state: 'running' }]
  state.tables.admin_acquisition_control = [{ id: 1, desired_state: 'running', epoch: 'epoch' }]
  state.tables.worker_runs = [{ id: 'run', status: 'running' }]; state.tables.admin_outreach_threads = []
  const item = candidate(), saved = context(), events: string[] = []; let inference = 0
  groq.chat.completions.create = (async () => { inference++; throw new Error('Invitation inference forbidden') }) as unknown as typeof original
  boundary.rpcOverride = async (name, args) => {
    events.push(name)
    if (name === 'mahshar_acquisition_template_context') return { data: saved, error: null }
    assert.equal(name, 'mahshar_acquisition_save_template_draft', 'No inference budget, reservation, dispatch or research RPC is permitted')
    assert.equal(args.p_template_version, INVITATION_TEMPLATE_VERSION)
    assert.equal(args.p_evidence_key, saved.key); assert.equal(args.p_claim_token, 'lease')
    const expected = renderInvitationTemplate(saved.templateVariables); assert.ok(expected.ok)
    assert.equal(args.p_subject, expected.draft.subject); assert.equal(args.p_body, expected.draft.body)
    return { data: true, error: null }
  }
  try { await action(events, item, saved); assert.equal(inference, 0) } finally {
    groq.chat.completions.create = original; boundary.rpcOverride = null
    keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i] })
  }
}

test('template drafting works without Groq configuration or sending eligibility and never reserves or dispatches', async () => offline(async (events, item) => {
  const port = acquisitionPort('run', 'epoch'); let used = false
  port.next = async () => used ? null : (used = true, item)
  assert.deepEqual(await processAcquisitionBatch(port, 10), ['prepared'])
  assert.deepEqual(events, ['mahshar_acquisition_template_context', 'mahshar_acquisition_save_template_draft'])
  const draft = renderInvitationTemplate(variables()); assert.ok(draft.ok)
  await assert.rejects(port.reserve(item, draft.draft), /draft_only/)
  await assert.rejects(port.dispatch('none', item, draft.draft), /draft_only/)
  await assert.rejects(port.delivered('none', 'none'), /draft_only/)
  await assert.rejects(port.ambiguous('none'), /draft_only/)
}))

test('saved directory-only providers receive neutral generic drafts without title or domain leakage', async () => offline(async (_events, item, saved) => {
  for (const provider of providers) {
    saved.templateVariables = { company: provider.domain, product: provider.product, companyVerified: true, productVerified: true }
    const rendered = renderInvitationTemplate(saved.templateVariables); assert.ok(rendered.ok)
    assert.deepEqual(await acquisitionPort('run', 'epoch').draft(item), rendered.draft)
    assert.match(rendered.draft.body, /^Hello team,/)
    assert.ok(rendered.draft.body.includes('listing one of your APIs'))
    assert.ok(!rendered.draft.body.includes(provider.domain) && !rendered.draft.body.includes(provider.product))
  }
}))

test('missing names use the generic fallback and continue to the next provider without skip or inference', async () => offline(async (_events, item, saved) => {
  const port = acquisitionPort('run', 'epoch'), skipped: string[] = []
  const original = boundary.rpcOverride!; let index = 0
  port.next = async () => index++ < 2 ? { ...item, attemptId: `attempt-${index}` } : null
  boundary.rpcOverride = async (name, args) => {
    if (name === 'mahshar_acquisition_template_context') return { data: { ...saved, templateVariables: index === 1 ? { ...variables(), company: null } : variables() }, error: null }
    if (name === 'mahshar_acquisition_record_draft') { skipped.push(String(args.p_reason)); return { data: true, error: null } }
    return original(name, args)
  }
  assert.deepEqual(await processAcquisitionBatch(port, 10), ['prepared', 'prepared'])
  assert.deepEqual(skipped, [])
}))

test('current suppression and identity/contact failure never save a draft', async () => offline(async (events, item, saved) => {
  const port = acquisitionPort('run', 'epoch')
  for (const key of ['allowed', 'identityVerified', 'contactVerified'] as const) {
    saved[key] = false; await assert.rejects(port.draft(item), AcquisitionPreparationSkip); saved[key] = true
  }
  assert.ok(!events.includes('mahshar_acquisition_save_template_draft'))
  state.tables.admin_outreach_threads = [{ id: 'thread', provider_id: item.providerId }]
  port.next = async () => item
  boundary.rpcOverride = async (name, args) => {
    assert.equal(name, 'mahshar_acquisition_record_draft'); assert.equal(args.p_reason, 'prior_outreach')
    return { data: true, error: null }
  }
  assert.deepEqual(await processAcquisitionBatch(port, 1), ['prior_outreach'])
}))

test('Stop and rejected/lost checkpoints pause without failure overwrite; legacy canary stays mock', async () => offline(async (events, item) => {
  const port = acquisitionPort('run', 'epoch')
  state.tables.worker_control[0].desired_state = 'stopped'
  await assert.rejects(port.draft(item), AcquisitionBudgetPause)
  assert.ok(!events.includes('mahshar_acquisition_save_template_draft'))
  state.tables.worker_control[0].desired_state = 'running'
  const original = boundary.rpcOverride!
  for (const lost of [false, true]) {
    boundary.rpcOverride = async (name, args) => {
      if (name === 'mahshar_acquisition_save_template_draft') {
        if (lost) throw new Error('lost checkpoint response')
        return { data: false, error: null }
      }
      return original(name, args)
    }
    await assert.rejects(port.draft(item), AcquisitionBudgetPause)
  }
  assert.deepEqual(await acquisitionPort('run', 'epoch', true).draft(item), mockCanaryAcquisitionDraft({ ...item, evidence: ['saved'] }))
}))
