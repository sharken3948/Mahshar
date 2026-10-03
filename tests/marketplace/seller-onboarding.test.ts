import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { LISTING_VERIFICATION_TIMEOUT_MS } from '../../src/lib/marketplace/listing-verification-timeout'

const read = (path: string) => readFileSync(path, 'utf8')

test('listing verification uses 15 seconds without changing paid proxy or Worker Discovery timeouts', () => {
  assert.equal(LISTING_VERIFICATION_TIMEOUT_MS, 15_000)
  for (const path of ['src/app/api/ai/score/route.ts', 'src/app/api/apis/[id]/verify/route.ts']) {
    const route = read(path)
    assert.match(route, /timeoutMs: LISTING_VERIFICATION_TIMEOUT_MS/)
    assert.match(route, /setTimeout\(\(\) => controller\.abort\(\), LISTING_VERIFICATION_TIMEOUT_MS\)/)
  }
  assert.match(read('src/lib/proxy.ts'), /signal: AbortSignal\.timeout\(10_000\)/)
  assert.match(read('src/lib/admin-worker/constants.ts'), /WORKER_EXTERNAL_TIMEOUT_MS = 6_000/)
})

test('Seller is a compact three-card workspace with one supporting assistant rail', () => {
  const form = read('src/components/OnboardingForm.tsx')
  const css = read('src/components/onboarding-form.module.css')
  for (const title of ['API Setup', 'Request & Response', 'Pricing & Publish', 'Mahshar Assistant']) {
    assert.ok(form.includes(title), title)
  }
  assert.match(css, /grid-template-columns: minmax\(0, 1fr\) minmax\(360px, 400px\)/)
  assert.match(css, /\.assistant\s*\{\s*position: sticky/)
  assert.match(read('src/app/seller/seller.module.css'), /1640px/)
  assert.doesNotMatch(form, /Continue to AI Review|List My API|Expected non-2xx status codes/)
})

test('Seller wallet CTA and listing actions remain centered, ordered, and analysis-gated', () => {
  const page = read('src/app/seller/page.tsx')
  const pageCss = read('src/app/seller/seller.module.css')
  const form = read('src/components/OnboardingForm.tsx')
  const endpointCard = form.slice(form.indexOf('<Card title="API Setup"'), form.indexOf('<Card title="Request & Response"'))
  const publishCardStart = form.indexOf('<Card title="Pricing & Publish"')
  const assistantStart = form.indexOf('<Assistant analysis=', publishCardStart)
  const publishCard = form.slice(publishCardStart, assistantStart)
  assert.match(page, /className=\{styles\.connectAction\}><ConnectButton/)
  assert.match(pageCss, /\.connectAction\s*\{[^}]*display: flex;[^}]*width: 100%;[^}]*justify-content: center;/)
  assert.doesNotMatch(endpointCard, />Analyze</)
  const preview = form.indexOf('>Preview</button>', publishCardStart)
  const analyze = form.indexOf(": 'Analyze'}</button>", publishCardStart)
  const publish = form.indexOf("'Publish API'", publishCardStart)
  assert.ok(publishCardStart > -1 && assistantStart > publishCardStart)
  assert.ok(preview > publishCardStart && analyze > preview && publish > analyze && publish < assistantStart)
  assert.match(form, /Analyze is required before publishing/)
  assert.match(publishCard, /disabled=\{!publishReady \|\| publishing \|\| analyzing\}/)
})

test('Suggested Setup renders every suggestion without clipping long values', () => {
  const form = read('src/components/OnboardingForm.tsx')
  const css = read('src/components/onboarding-form.module.css')
  for (const label of ['API Name', 'Category', 'Method', 'Authentication', 'Credential parameter', 'Description',
    'Example request', 'Example response', 'Request body', 'Path parameters', 'Query parameters']) {
    assert.ok(form.includes(`label="${label}"`), label)
  }
  assert.match(css, /\.suggestionList p\s*\{[^}]*overflow-wrap: anywhere;[^}]*white-space: pre-wrap;/)
  assert.doesNotMatch(css, /\.suggestionList p[^}]*-webkit-line-clamp/)
})

test('Seller card headers reuse the established Dashboard blue, purple, and green treatments', () => {
  const css = read('src/components/onboarding-form.module.css')
  for (const gradient of [
    'linear-gradient(112deg, #c9e2ff 0%, #ddecff 58%, #f3f8ff 100%)',
    'linear-gradient(112deg, #ddd1ff 0%, #ece4ff 58%, #f8f5ff 100%)',
    'linear-gradient(112deg, #c7edd8 0%, #dcf5e6 58%, #f1fbf5 100%)',
  ]) assert.ok(css.includes(gradient), gradient)
  assert.doesNotMatch(css, /\.assistantHeader[^}]*c9e2ff|\.assistantHeader[^}]*ddd1ff|\.assistantHeader[^}]*c7edd8/)
})

test('Seller keeps suggestions explicit, manual parameters available, and Groq out of readiness authority', () => {
  const form = read('src/components/OnboardingForm.tsx')
  assert.match(form, /Apply suggestions/)
  assert.match(form, /RequestParameterEditor location="path"/)
  assert.match(form, /RequestParameterEditor location="query"/)
  assert.match(form, /analysis\?\.endpoint_verified === true/)
  assert.match(form, /const publishReady = metadataComplete && endpointVerified && requestValid && authComplete && priceValid/)
  assert.doesNotMatch(form, /approved.*publishReady|score.*publishReady/)
})

test('publish saves an inactive listing, rechecks stored configuration, then activates it', () => {
  const form = read('src/components/OnboardingForm.tsx')
  const create = form.indexOf("marketplaceFetch('/api/apis'")
  const persistedReview = form.indexOf("marketplaceFetch('/api/ai/score'", create)
  const activate = form.indexOf('is_active: true', persistedReview)
  assert.ok(create > -1 && persistedReview > create && activate > persistedReview)
  assert.match(form, /api_id: id/)
  assert.match(form, /review\?\.endpoint_verified/)
})

test('analysis persists deterministic verification before the optional model call', () => {
  const route = read('src/app/api/ai/score/route.ts')
  const verification = route.indexOf("update({ verified_at:")
  const model = route.indexOf('aiResult = await scoreApi')
  assert.ok(verification > -1 && model > verification)
  assert.match(route, /publishing must not depend on this optional write/)
})
