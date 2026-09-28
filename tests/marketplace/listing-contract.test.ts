import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { normalizeExpectedStatusCodes } from '../../src/lib/marketplace/listing-security'

test('OpenAPI and checked-in schema match the runtime listing contract', () => {
  const openapi = readFileSync('openapi.yaml', 'utf8')
  const schema = readFileSync('supabase/schema.sql', 'utf8')
  assert.doesNotMatch(openapi, /enum: \[[^\]]*PATCH/)
  assert.match(openapi, /enum: \[GET, POST, PUT, DELETE\]/)
  assert.match(openapi, /enum: \[public, apikey, bearer, queryparam\]/)
  assert.match(schema, /auth_type in \('public', 'apikey', 'bearer', 'queryparam'\)/)
  assert.match(schema, /auth_param_name text/)
})

test('seller listing editor preserves query-parameter authentication fields', () => {
  const workspace = readFileSync('src/app/dashboard/dashboard-workspace.tsx', 'utf8')
  const page = readFileSync('src/app/dashboard/apis/page.tsx', 'utf8')
  assert.match(page, /option value="queryparam"/)
  assert.match(page, /editForm\.auth_type === 'queryparam'[\s\S]*editForm\.auth_param_name/)
  assert.match(workspace, /auth_param_name: api\.auth_param_name \?\? ''/)
  assert.match(workspace, /auth_param_name: nextAuthParamName/)
  assert.match(page, /RequestParameterEditor location="path"/)
  assert.match(page, /RequestParameterEditor location="query"/)
  assert.match(workspace, /path_parameters: editForm\.dynamic_path_supported/)
  assert.match(workspace, /query_parameters: editForm\.query_parameters/)
})

test('transient infrastructure statuses can never be declared expected', () => {
  for (const status of [408, 429, 502, 503, 504]) {
    const result = normalizeExpectedStatusCodes([status])
    assert.equal(result.ok, false, String(status))
  }
  assert.deepEqual(normalizeExpectedStatusCodes([400, 404, 422]), { ok: true, codes: [400, 404, 422] })
})

test('buyer request-body modal displays the configured method instead of hard-coded POST', () => {
  const buyer = readFileSync('src/app/buyer/page.tsx', 'utf8')
  assert.match(buyer, /methodBadge}>\{requestModal\.method\}/)
  assert.doesNotMatch(buyer, /methodBadge}>POST</)
  assert.match(buyer, /Path · \{parameter\.name\}/)
  assert.match(buyer, /Query · \{parameter\.name\}/)
  assert.match(buyer, /Will be sent/)
  assert.match(buyer, /buildBuyerRequestSuffix/)
})

test('onboarding distinguishes GET query inputs from body examples and uses progressive authoring', () => {
  const onboarding = readFileSync('src/components/OnboardingForm.tsx', 'utf8')
  assert.match(onboarding, /Path and query inputs/)
  assert.match(onboarding, /This endpoint accepts variable path segments/)
  assert.match(onboarding, /GET requests do not forward JSON bodies/)
  assert.match(onboarding, /Example JSON Body/)
  assert.match(onboarding, /dynamic_path_supported/)
  assert.match(onboarding, /query_parameters/)
})
