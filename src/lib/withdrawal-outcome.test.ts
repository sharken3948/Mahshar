import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyGatewayTransferResponse, classifyGatewayTransferStatus } from './withdrawal-outcome'

const attestation = `0x${'ab'.repeat(32)}`
const signature = `0x${'cd'.repeat(65)}`

test('post-dispatch timeout, server error, malformed data, and uncertain failure stay unknown', () => {
  for (const [status, body] of [
    [500, { success: false, message: 'internal error' }],
    [503, null],
    [200, null],
    [200, { success: false, message: 'uncertain' }],
    [200, { attestation: 'truncated', signature }],
  ] as const) assert.equal(classifyGatewayTransferResponse(status, body).kind, 'unknown')
})

test('only explicit validation/auth rejection releases while complete success is accepted', () => {
  assert.equal(classifyGatewayTransferResponse(400, { success: false, message: 'invalid burn intent' }).kind, 'rejected')
  assert.equal(classifyGatewayTransferResponse(422, { success: false, message: 'invalid signature' }).kind, 'rejected')
  assert.equal(classifyGatewayTransferResponse(400, { message: 'missing explicit failure' }).kind, 'unknown')
  assert.deepEqual(classifyGatewayTransferResponse(200, { attestation, signature, transferId: 'transfer-1' }),
    { kind: 'accepted', attestation, signature, transferId: 'transfer-1' })
})

test('queryable transfer status distinguishes pending, proven failure, and recoverable attestation', () => {
  assert.equal(classifyGatewayTransferStatus({ status: 'pending' }).kind, 'pending')
  assert.equal(classifyGatewayTransferStatus({ status: 'failed', forwardingDetails: { failureReason: 'rejected' } }).kind, 'rejected')
  assert.equal(classifyGatewayTransferStatus({ status: 'expired' }).kind, 'rejected')
  assert.equal(classifyGatewayTransferStatus({ status: 'confirmed' }).kind, 'unknown')
  assert.equal(classifyGatewayTransferStatus({ status: 'finalized', attestation: { payload: attestation, signature } }).kind, 'accepted')
})
