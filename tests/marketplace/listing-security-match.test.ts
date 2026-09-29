import assert from 'node:assert/strict'
import { test } from 'node:test'
import { matchListingConfiguration, matchListingVerificationConfiguration, SENSITIVE_CONFIGURATION,
  VERIFICATION_CONFIGURATION } from '../../src/lib/marketplace/listing-security'

type Call = { column: string; operator: string; value: unknown }
function recorder() {
  const calls: Call[] = []
  const builder: { filter(column: string, operator: string, value: unknown): typeof builder } = {
    filter(column, operator, value) { calls.push({ column, operator, value }); return builder },
  }
  return { calls, builder }
}
const findCall = (calls: Call[], column: string) => calls.find(call => call.column === column)

test('matchListingConfiguration serializes jsonb array columns as JSON strings', () => {
  const { calls, builder } = recorder()
  const listing = {
    endpoint_url: 'https://seller.example/data', auth_type: 'apikey',
    encrypted_key: 'ciphertext', auth_param_name: null, method: 'GET',
    body_required: false, dynamic_path_supported: false,
    path_parameters: [], query_parameters: [{ name: 'x', required: true }],
  }
  matchListingConfiguration(builder, listing)

  assert.equal(calls.length, SENSITIVE_CONFIGURATION.length)
  assert.deepEqual(findCall(calls, 'path_parameters'), { column: 'path_parameters', operator: 'eq', value: '[]' })
  assert.deepEqual(findCall(calls, 'query_parameters'),
    { column: 'query_parameters', operator: 'eq', value: '[{"name":"x","required":true}]' })
})

test('matchListingConfiguration uses "is null" for null jsonb columns', () => {
  const { calls, builder } = recorder()
  matchListingConfiguration(builder, {
    endpoint_url: 'https://seller.example/data', auth_type: 'public',
    encrypted_key: null, auth_param_name: null, method: 'GET',
    body_required: null, dynamic_path_supported: false,
    path_parameters: null, query_parameters: null,
  })

  assert.deepEqual(findCall(calls, 'path_parameters'), { column: 'path_parameters', operator: 'is', value: null })
  assert.deepEqual(findCall(calls, 'query_parameters'), { column: 'query_parameters', operator: 'is', value: null })
  assert.deepEqual(findCall(calls, 'encrypted_key'), { column: 'encrypted_key', operator: 'is', value: null })
  assert.deepEqual(findCall(calls, 'auth_param_name'), { column: 'auth_param_name', operator: 'is', value: null })
  assert.deepEqual(findCall(calls, 'body_required'), { column: 'body_required', operator: 'is', value: null })
})

test('matchListingConfiguration passes text and boolean columns through unchanged', () => {
  const { calls, builder } = recorder()
  matchListingConfiguration(builder, {
    endpoint_url: 'https://seller.example/data', auth_type: 'bearer',
    encrypted_key: 'ciphertext', auth_param_name: 'X-Api-Key', method: 'POST',
    body_required: true, dynamic_path_supported: true,
    path_parameters: null, query_parameters: null,
  })

  assert.deepEqual(findCall(calls, 'endpoint_url'),
    { column: 'endpoint_url', operator: 'eq', value: 'https://seller.example/data' })
  assert.deepEqual(findCall(calls, 'auth_type'), { column: 'auth_type', operator: 'eq', value: 'bearer' })
  assert.deepEqual(findCall(calls, 'encrypted_key'), { column: 'encrypted_key', operator: 'eq', value: 'ciphertext' })
  assert.deepEqual(findCall(calls, 'auth_param_name'), { column: 'auth_param_name', operator: 'eq', value: 'X-Api-Key' })
  assert.deepEqual(findCall(calls, 'method'), { column: 'method', operator: 'eq', value: 'POST' })
  assert.deepEqual(findCall(calls, 'body_required'), { column: 'body_required', operator: 'eq', value: true })
  assert.deepEqual(findCall(calls, 'dynamic_path_supported'),
    { column: 'dynamic_path_supported', operator: 'eq', value: true })
})

test('verification compare-and-set also binds the representative request and expected status array', () => {
  const { calls, builder } = recorder()
  matchListingVerificationConfiguration(builder, {
    endpoint_url: 'https://seller.example/data', auth_type: 'public', encrypted_key: null,
    auth_param_name: null, method: 'POST', body_required: true, dynamic_path_supported: false,
    path_parameters: [], query_parameters: [], example_request: '{"value":1}', expected_status_codes: [400, 422],
  })

  assert.equal(calls.length, VERIFICATION_CONFIGURATION.length)
  assert.deepEqual(findCall(calls, 'example_request'),
    { column: 'example_request', operator: 'eq', value: '{"value":1}' })
  assert.deepEqual(findCall(calls, 'expected_status_codes'),
    { column: 'expected_status_codes', operator: 'eq', value: '{400,422}' })
})
