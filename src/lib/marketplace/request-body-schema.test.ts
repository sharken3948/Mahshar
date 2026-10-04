import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateRequestBody, validateSupportedRequestSchema } from './request-body-schema'

const ioscopeSchema = {
  type: 'object',
  required: ['address', 'chain'],
  properties: {
    address: { type: 'string', minLength: 1 },
    chain: { type: 'string', enum: ['arc'] },
  },
}

test('Ioscope request schema accepts only the required syntactic contract', () => {
  assert.deepEqual(validateSupportedRequestSchema(ioscopeSchema), { ok: true })
  assert.deepEqual(validateRequestBody(ioscopeSchema, { address: '0x1234', chain: 'arc' }), { ok: true })
  for (const body of [undefined, null, {}, { chain: 'arc' }, { address: '0x1234' },
    { address: '', chain: 'arc' }, { address: 123, chain: 'arc' }, { address: '0x1234', chain: 'ethereum' }]) {
    assert.equal(validateRequestBody(ioscopeSchema, body).ok, false)
  }
})

test('request schema support rejects unknown behavior instead of pretending to enforce it', () => {
  assert.equal(validateSupportedRequestSchema({ type: 'string', pattern: '^0x' }).ok, false)
  assert.equal(validateSupportedRequestSchema({ type: 'object', required: ['missing'], properties: {} }).ok, false)
  assert.equal(validateSupportedRequestSchema({ type: 'object', properties: { address: { minLength: 1 } } }).ok, false)
})

test('const support is limited to deterministic scalar JSON values', () => {
  for (const schema of [
    { type: 'object', const: { chain: 'arc' }, properties: { chain: { type: 'string' } } },
    { type: 'array', const: ['arc'], items: { type: 'string' } },
  ]) assert.equal(validateSupportedRequestSchema(schema).ok, false)
  for (const [schema, matching, different] of [
    [{ type: 'string', const: 'arc' }, 'arc', 'base'],
    [{ type: 'number', const: 5042 }, 5042, 1],
    [{ type: 'boolean', const: true }, true, false],
    [{ type: 'null', const: null }, null, 'null'],
  ] as const) {
    assert.equal(validateSupportedRequestSchema(schema).ok, true)
    assert.equal(validateRequestBody(schema, matching).ok, true)
    assert.equal(validateRequestBody(schema, different).ok, false)
  }
})

test('contradictory paired bounds are rejected at configuration time', () => {
  assert.equal(validateSupportedRequestSchema({ type: 'string', minLength: 2, maxLength: 1 }).ok, false)
  assert.equal(validateSupportedRequestSchema({ type: 'array', minItems: 2, maxItems: 1, items: { type: 'string' } }).ok, false)
  assert.equal(validateSupportedRequestSchema({ type: 'number', minimum: 2, maximum: 1 }).ok, false)
  assert.equal(validateSupportedRequestSchema({ type: 'integer', minimum: 2, maximum: 1 }).ok, false)
})
