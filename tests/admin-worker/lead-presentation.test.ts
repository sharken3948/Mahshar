import assert from 'node:assert/strict'
import { test } from 'node:test'
import { workerLeadContactLabel } from '../../src/app/admin/worker/lead-presentation'
import type { WorkerQualifiedLeadDto } from '../../src/lib/admin-worker/types'

type ContactLead = Pick<WorkerQualifiedLeadDto, 'preferred_email' | 'contactability' | 'contact_evidence'>

const lead = (overrides: Partial<ContactLead>): ContactLead => ({
  preferred_email: null, contactability: 'unknown', contact_evidence: [], ...overrides,
})

test('compact Worker contact labels use verified outreach semantics', () => {
  assert.equal(workerLeadContactLabel(lead({ preferred_email: 'team@example.com', contactability: 'verified_email' })), 'Email')
  assert.equal(workerLeadContactLabel(lead({ contactability: 'official_sales_channel' })), 'Sales')
  assert.equal(workerLeadContactLabel(lead({ contactability: 'official_contact_page' })), 'Contact form')
  assert.equal(workerLeadContactLabel(lead({ contactability: 'contact_unavailable' })), 'Unavailable')
  assert.equal(workerLeadContactLabel(lead({ contactability: 'unknown' })), 'Unknown')
  assert.equal(workerLeadContactLabel(lead({ contactability: 'verified_official_contact', contact_evidence: [{
    type: 'official_contact', value: 'https://example.com/support', source_url: 'https://example.com/support',
    purpose: 'support', source_type: 'official_site', preferred: true,
  }] })), 'Support')
})
