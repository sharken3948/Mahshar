import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

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
})

test('buyer request-body modal displays the configured method instead of hard-coded POST', () => {
  const buyer = readFileSync('src/app/buyer/page.tsx', 'utf8')
  assert.match(buyer, /methodBadge}>\{requestModal\.method\}/)
  assert.doesNotMatch(buyer, /methodBadge}>POST</)
})
