import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateListingRequestContract } from './request-contract'
import { authorizeProxyTarget, ProxyTargetError } from './proxy-target'
import { buildUpstreamAuthentication } from './upstream-auth'

const anewone = {
  endpoint_url: 'https://anewone.xyz/api/basedbot/tokens',
  method: 'GET',
  auth_type: 'public',
  auth_param_name: null,
  dynamic_path_supported: false,
  path_parameters: [],
  query_parameters: [
    { name: 'limit', type: 'integer' as const, required: false, minimum: 1, maximum: 100, example: 10,
      description: 'Maximum number of tokens' },
    { name: 'sort', type: 'string' as const, required: false, example: 'volume24h', enum: [
      'volume24h', 'volumeAll', 'marketCap', 'fdv', 'liquidity', 'trades24h', 'holders', 'age', 'created',
    ] },
  ],
  body_required: false,
}

test('Anewone fixed GET contract produces the exact executable canonical URL', () => {
  const result = validateListingRequestContract({ ...anewone, example_request: '{"limit":10,"sort":"volume24h"}' })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.example.suffix, '?limit=10&sort=volume24h')
  assert.equal(result.example.canonical_target, 'https://anewone.xyz/api/basedbot/tokens?limit=10&sort=volume24h')
  assert.equal(result.example.body, null)
})

test('Anewone legacy GET example rejects status because it is undeclared', () => {
  const result = validateListingRequestContract({ ...anewone, example_request: '{"limit":10,"status":"active"}' })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.field, 'example_request')
  assert.match(result.error, /undeclared query parameter "status"/)
})

test('method-specific body semantics cover GET, POST, PUT, and DELETE', () => {
  const common = { endpoint_url: 'https://api.example/items', auth_type: 'public', dynamic_path_supported: false,
    path_parameters: [], query_parameters: [] }
  assert.equal(validateListingRequestContract({ ...common, method: 'GET', body_required: true }).ok, false)
  for (const method of ['POST', 'PUT'] as const) {
    assert.equal(validateListingRequestContract({ ...common, method, body_required: true, example_request: '' }).ok, false)
    assert.equal(validateListingRequestContract({ ...common, method, body_required: true, example_request: '{"value":1}' }).ok, true)
  }
  assert.equal(validateListingRequestContract({ ...common, method: 'DELETE', body_required: false, example_request: '' }).ok, true)
  assert.equal(validateListingRequestContract({ ...common, method: 'DELETE', body_required: true, example_request: '{"reason":"test"}' }).ok, true)
})

test('request schemas validate the representative body used for listing verification', () => {
  const common = { endpoint_url: 'https://api.example/analyze', auth_type: 'public', dynamic_path_supported: false,
    path_parameters: [], query_parameters: [], method: 'POST', body_required: true }
  const request_schema = { type: 'object', required: ['address', 'chain'], properties: {
    address: { type: 'string', minLength: 1 }, chain: { type: 'string', enum: ['arc'] },
  } }
  assert.equal(validateListingRequestContract({ ...common, request_schema,
    example_request: '{"address":"0x1234","chain":"arc"}' }).ok, true)
  const invalid = validateListingRequestContract({ ...common, request_schema,
    example_request: '{"address":"","chain":"arc"}' })
  assert.equal(invalid.ok, false)
  if (!invalid.ok) assert.equal(invalid.field, 'example_request')
})

test('an optional schema allows an absent example and validates any supplied example', () => {
  const common = { endpoint_url: 'https://api.example/analyze', auth_type: 'public', dynamic_path_supported: false,
    path_parameters: [], query_parameters: [], method: 'POST', body_required: false,
    request_schema: { type: 'object', required: ['chain'], properties: { chain: { type: 'string', enum: ['arc'] } } } }
  assert.equal(validateListingRequestContract({ ...common, example_request: '' }).ok, true)
  assert.equal(validateListingRequestContract({ ...common, example_request: '{"chain":"arc"}' }).ok, true)
  assert.equal(validateListingRequestContract({ ...common, example_request: '{"chain":"base"}' }).ok, false)
})

test('four auth models preserve one request contract while injecting only stored credentials after validation', () => {
  const models = [
    { auth_type: 'public' as const, auth_param_name: null },
    { auth_type: 'apikey' as const, auth_param_name: null },
    { auth_type: 'bearer' as const, auth_param_name: null },
    { auth_type: 'queryparam' as const, auth_param_name: 'api_key' },
  ]
  for (const model of models) {
    const listing = { ...anewone, ...model, example_request: '{"limit":10,"sort":"volume24h"}' }
    const contract = validateListingRequestContract(listing)
    assert.equal(contract.ok, true, model.auth_type)
    if (!contract.ok) continue
    const validated = authorizeProxyTarget(listing, contract.example.suffix)
    const outbound = buildUpstreamAuthentication(validated, model.auth_type, model.auth_type === 'public' ? undefined : 'stored-secret', model.auth_param_name)
    assert.equal(outbound.requestUrl.searchParams.get('limit'), '10')
    assert.equal(outbound.requestUrl.searchParams.get('sort'), 'volume24h')
    assert.equal(outbound.headers['x-api-key'], model.auth_type === 'apikey' ? 'stored-secret' : undefined)
    assert.equal(outbound.headers.authorization, model.auth_type === 'bearer' ? 'Bearer stored-secret' : undefined)
    assert.equal(outbound.requestUrl.searchParams.get('api_key'), model.auth_type === 'queryparam' ? 'stored-secret' : null)
    assert.equal(outbound.requestUrl.searchParams.getAll('api_key').length, model.auth_type === 'queryparam' ? 1 : 0)
  }
})

test('query credential cannot collide with buyer declarations or encoded buyer input', () => {
  const collision = validateListingRequestContract({ ...anewone, auth_type: 'queryparam', auth_param_name: 'api_key',
    query_parameters: [...anewone.query_parameters, { name: 'API_KEY', type: 'string' }] })
  assert.equal(collision.ok, false)
  const listing = { ...anewone, auth_type: 'queryparam', auth_param_name: 'api_key' }
  for (const suffix of ['?api_key=x', '?API_KEY=x', '?%61pi_key=x', '?api_key=x&api_key=y', '?%2561pi_key=x']) {
    assert.throws(() => authorizeProxyTarget(listing, suffix), ProxyTargetError, suffix)
  }
})

test('required path examples, query bounds, and restrictive legacy defaults fail closed', () => {
  const missingPath = validateListingRequestContract({ ...anewone, dynamic_path_supported: true,
    path_parameters: [{ name: 'address', type: 'string', required: true }] })
  assert.equal(missingPath.ok, false)
  assert.throws(() => authorizeProxyTarget({ ...anewone, dynamic_path_supported: true,
    path_parameters: [{ name: 'address', type: 'string', required: true }] }, ''), ProxyTargetError)
  assert.equal(authorizeProxyTarget({ endpoint_url: anewone.endpoint_url }, '').toString(), anewone.endpoint_url)
  assert.throws(() => authorizeProxyTarget({ endpoint_url: anewone.endpoint_url }, '?limit=10'), ProxyTargetError)
  assert.throws(() => authorizeProxyTarget(anewone, '?limit=101'), ProxyTargetError)
})
