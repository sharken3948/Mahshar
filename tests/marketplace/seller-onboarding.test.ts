import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (path: string) => readFileSync(path, 'utf8')

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
