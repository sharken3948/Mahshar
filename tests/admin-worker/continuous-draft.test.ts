import assert from 'node:assert/strict'
import { test } from 'node:test'
import { boundary } from '../admin/fixture'
import { groq } from '../../src/lib/groq-neutral'
import { acquisitionPort } from '../../src/lib/admin-worker/acquisition-runtime'
import { AcquisitionBudgetPause, mockCanaryAcquisitionDraft, type AcquisitionCandidate } from '../../src/lib/admin-worker/acquisition'

const item: AcquisitionCandidate = { attemptId: 'attempt', providerId: 'fixture', leadId: 'lead',
  provider: 'Fixture', product: 'Weather API', email: 'team@example.com', emailObserved: true,
  emailValid: true, evidenceVerified: true, recipientEligible: true, channelApproved: true,
  evidence: ['https://example.com/docs'] }

test('continuous drafting checkpoints valid mocked Groq output and reuses it after a quota wait', async () => {
  const oldCreate = groq.chat.completions.create; const oldKey = process.env.GROQ_API_KEY
  const draft = mockCanaryAcquisitionDraft(item); const events: string[] = []
  process.env.GROQ_API_KEY = 'synthetic-offline-fixture'
  // The fixture supplies only the awaited response, not the SDK's APIPromise helpers.
  groq.chat.completions.create = (async () => { events.push('mock-groq'); return { choices: [{ message: { content: JSON.stringify(draft) } }] } }) as unknown as typeof oldCreate
  boundary.rpcOverride = async (name, args) => {
    if (name === 'mahshar_worker_claim_budget_v2') { events.push('budget'); return { data: 'claimed', error: null } }
    assert.equal(name, 'mahshar_acquisition_save_draft'); events.push('checkpoint-draft')
    assert.equal(args.p_generator, 'groq')
    assert.equal(args.p_subject, draft.subject)
    assert.equal(args.p_body, draft.body)
    return { data: true, error: null }
  }
  try {
    assert.deepEqual(await acquisitionPort('run', 'epoch').draft(item), draft)
    assert.deepEqual(events, ['budget', 'mock-groq', 'checkpoint-draft'])
    events.length = 0
    assert.deepEqual(await acquisitionPort('resumed-run', 'epoch').draft({ ...item, savedDraft: draft }), draft)
    assert.deepEqual(events, [])
    assert.deepEqual(await acquisitionPort('run', 'epoch', true).draft(item), draft)
    assert.deepEqual(events, [], 'canary mock draft never receives Groq provenance')
    groq.chat.completions.create = (async () => ({ choices: [{ message: { content: JSON.stringify({ subject: 'Invalid', body: 'No grounded invitation' }) } }] })) as unknown as typeof oldCreate
    await acquisitionPort('run', 'epoch').draft(item)
    assert.deepEqual(events, ['budget'], 'invalid model output is never checkpointed or marked Groq')
    events.length = 0
    groq.chat.completions.create = (async () => ({ choices: [{ message: { content: 'invalid JSON' } }] })) as unknown as typeof oldCreate
    await assert.rejects(acquisitionPort('run', 'epoch').draft(item), SyntaxError)
    assert.deepEqual(events, ['budget'])
    events.length = 0
    groq.chat.completions.create = (async () => { throw { status: 429 } }) as unknown as typeof oldCreate
    await assert.rejects(acquisitionPort('run', 'epoch').draft(item), AcquisitionBudgetPause)
    assert.deepEqual(events, ['budget'])
  } finally {
    groq.chat.completions.create = oldCreate; boundary.rpcOverride = null
    if (oldKey === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = oldKey
  }
})
