import assert from 'node:assert/strict'
import test from 'node:test'
import { acquisitionPort } from '../../src/lib/admin-worker/acquisition-runtime'
import { validAcquisitionDraft, type AcquisitionCandidate } from '../../src/lib/admin-worker/acquisition'

test('canary adapter drafts and dispatches with Groq unavailable and network forbidden', async () => {
  const previousKey = process.env.GROQ_API_KEY
  delete process.env.GROQ_API_KEY
  try {
    const candidate: AcquisitionCandidate = {
      providerId: 'fixture', leadId: 'fixture-lead', provider: 'Fixture Provider', product: 'Weather API',
      email: 'business@example.com', emailObserved: true, emailValid: true, evidenceVerified: true,
      recipientEligible: true, channelApproved: true, evidence: ['https://example.com/weather/docs'],
    }
    const port = acquisitionPort('run', 'epoch', true)
    const draft = await port.draft(candidate)
    assert.equal(validAcquisitionDraft(candidate, draft), true)
    assert.match(draft.subject, /^\[Simulation\]/)
    assert.equal(await port.dispatch('reservation', candidate, draft), 'simulated:reservation')
  } finally {
    if (previousKey === undefined) delete process.env.GROQ_API_KEY
    else process.env.GROQ_API_KEY = previousKey
  }
})
