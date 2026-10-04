import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { beforeEach, test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import './edit-listing-register.mjs'
import { editListingState, resetEditListingState } from './edit-listing-register.mjs'
import type { ApiListing } from '../../src/types'

// Install module stubs before loading the client component.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { EditListingForm } = require('../../src/components/EditListingForm') as typeof import('../../src/components/EditListingForm')

const listing: ApiListing = {
  id: 'ioscope', name: 'ioscope', description: 'Stored description', category: 'Data', price_per_call: 0.0011,
  payment_model: 'pay-per-call', seller_wallet: `0x${'11'.repeat(20)}`, auth_type: 'bearer',
  encrypted_key: 'must-never-render', credential_configured: true, auth_param_name: null,
  endpoint_url: 'https://seller.example/ioscope', method: 'POST', example_request: '{"query":"stored"}',
  example_response: '{"stored":true}', score: 9, uptime: 100, created_at: '2026-01-01T00:00:00.000Z',
  is_active: true, verified_at: '2026-01-01T00:00:00.000Z', expected_status_codes: null,
  body_required: true, dynamic_path_supported: false, path_parameters: [],
  query_parameters: [{ name: 'limit', type: 'integer', required: false, example: 10 }],
}

beforeEach(resetEditListingState)

test('existing listing renders exact stored edit values without analysis or mutation on open', () => {
  const html = renderToStaticMarkup(React.createElement(EditListingForm, {
    listing, onClose: () => {}, onListingChange: () => {},
  }))
  assert.equal(editListingState.requests.length, 0)
  for (const value of ['ioscope', 'Stored description', 'https://seller.example/ioscope',
    '{&quot;query&quot;:&quot;stored&quot;}', '{&quot;stored&quot;:true}', '0.0011']) assert.ok(html.includes(value), value)
  assert.match(html, /Configured · leave blank to keep/)
  assert.doesNotMatch(html, /must-never-render/)
})

test('edit workspace mirrors Seller structure but exposes existing-listing lifecycle actions', () => {
  const html = renderToStaticMarkup(React.createElement(EditListingForm, {
    listing, onClose: () => {}, onListingChange: () => {},
  }))
  for (const label of ['API Setup', 'Request &amp; Response', 'Pricing &amp; Publish', 'Mahshar Assistant',
    'Analyze', 'Save changes', 'Deactivate', 'Preview']) assert.ok(html.includes(label), label)
  assert.doesNotMatch(html, />Publish API</)
})

test('Edit Listing places its one primary Analyze action with Preview and Save at the bottom', () => {
  const html = renderToStaticMarkup(React.createElement(EditListingForm, {
    listing, onClose: () => {}, onListingChange: () => {},
  }))
  const setup = html.slice(html.indexOf('API Setup'), html.indexOf('Request &amp; Response'))
  const publish = html.slice(html.indexOf('Pricing &amp; Publish'))
  assert.doesNotMatch(setup, />Analyze<\/button>/)
  assert.equal(html.match(/>Analyze<\/button>/g)?.length, 1)
  assert.ok(publish.indexOf('>Preview</button>') < publish.indexOf('>Analyze</button>'))
  assert.ok(publish.indexOf('>Analyze</button>') < publish.indexOf('>Save changes</button>'))
  assert.match(publish, /No unsaved changes/)
})

test('draft analysis and preview are explicit, advisory, and non-publishing in source', () => {
  const source = readFileSync('src/components/EditListingForm.tsx', 'utf8')
  assert.match(source, /draft: true/)
  assert.match(source, /Apply suggestions/)
  assert.match(source, /setShowPreview\(true\)/)
  assert.match(source, /onClick=\{\(\) => void analyzeEndpoint\(\)\}/)
  assert.match(source, /Suggestions applied to this draft/)
  assert.doesNotMatch(source, /useEffect\([^)]*analyzeEndpoint/)
  assert.doesNotMatch(source, /is_active: true[\s\S]*PreviewModal/)
})
