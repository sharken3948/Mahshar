import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { paymentErrorMessage } from '../../src/lib/payments/errors'

test('payment failures have safe human-readable messages', () => {
  assert.match(paymentErrorMessage('payment_storage_unavailable'), /Secure payment recording/)
  assert.match(paymentErrorMessage('payment_verification_service_unavailable'), /Circle payment verification/)
  assert.match(paymentErrorMessage('payment_accounting_unavailable', undefined, 'attempt-1'), /Do not approve another payment.*attempt-1/)
  assert.doesNotMatch(paymentErrorMessage('payment_storage_unavailable'), /payment_storage/)
})

test('Marketplace handles a failed payment probe before requesting wallet approval', () => {
  const buyer = readFileSync('src/app/buyer/page.tsx', 'utf8')
  const failedProbe = buyer.indexOf('if (!probeRes.ok)')
  const approval = buyer.indexOf('signTypedDataAsync({')
  assert.ok(failedProbe > 0 && approval > failedProbe)
  assert.match(buyer, /setPaymentError\(paymentErrorMessage\(data\.error, data\.message, data\.attemptId\)\)/)
})

test('Marketplace shows both balances, preflights Gateway funds, and confirms the fee-inclusive total before signing', () => {
  const buyer = readFileSync('src/app/buyer/page.tsx', 'utf8')
  const preflight = buyer.indexOf('gatewayCanPay(currentGatewayAvailable, requirements.amount)')
  const confirmation = buyer.indexOf('setPaymentConfirmation({')
  const approval = buyer.indexOf('signTypedDataAsync({')
  assert.ok(preflight > 0 && confirmation > preflight && approval > confirmation)
  assert.match(buyer, /Arc Wallet USDC/)
  assert.match(buyer, /Mahshar Balance/)
  assert.match(buyer, /Buyer platform fee/)
  assert.match(buyer, /Total payment/)
  assert.match(buyer, /\/dashboard\/wallet#deposit/)
})
