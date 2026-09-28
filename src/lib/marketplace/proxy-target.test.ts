import assert from 'node:assert/strict'
import { test } from 'node:test'
import { authorizeProxyTarget, ProxyTargetError } from './proxy-target'

const base = {
  endpoint_url: 'https://api.example/v1?fixed=yes',
  dynamic_path_supported: true,
  path_parameters: [
    { name: 'collection', enum: ['users'] },
    { name: 'id', type: 'integer' },
  ],
  query_parameters: [{ name: 'view', enum: ['summary', 'full'] }],
  auth_type: 'queryparam',
  auth_param_name: 'api_key',
}

function code(path: string, listing = base) {
  try { authorizeProxyTarget(listing, path); return null }
  catch (error) { return error instanceof ProxyTargetError ? error.code : 'unexpected' }
}

test('proxy target rejects direct and encoded dot-segment traversal', () => {
  for (const path of ['/../admin', '/../../users', '/%2e%2e/admin', '/%2E%2E/%2e%2e/users',
    '/%252e%252e/admin', '/users/%2e%2e', '/users/%252e%252e']) {
    assert.equal(code(path), 'invalid_dynamic_path', path)
  }
})

test('proxy target rejects every non-empty path when dynamic paths are disabled', () => {
  assert.equal(code('/users/42', { ...base, dynamic_path_supported: false }), 'dynamic_path_not_allowed')
  assert.equal(code('?view=summary', { ...base, dynamic_path_supported: false }), 'dynamic_path_not_allowed')
})

test('proxy target permits only declared path and query values and returns a canonical URL', () => {
  assert.equal(authorizeProxyTarget(base, '/users/42?view=summary').toString(),
    'https://api.example/v1/users/42?fixed=yes&view=summary')
  assert.equal(code('/admin/42?view=summary'), 'undeclared_path')
  assert.equal(code('/users/42?debug=true'), 'undeclared_query_parameter')
  assert.equal(code('/users/42?view=summary&view=full'), 'invalid_query_parameter')
})

test('buyer query cannot collide with the credential parameter', () => {
  assert.equal(code('/users/42?api_key=attacker'), 'credential_query_collision')
  assert.equal(code('/users/42?API_KEY=attacker'), 'credential_query_collision')
})
