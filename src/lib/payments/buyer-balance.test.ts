import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buyerPaymentQuote, gatewayCanPay, insufficientGatewayMessage } from './buyer-balance'

test('buyer quote uses the authoritative 402 total and exposes the included fee', () => {
  const quote = buyerPaymentQuote(0.1, '110000')
  assert.equal(quote.listed, '0.1')
  assert.equal(quote.fee, '0.01')
  assert.equal(quote.total, '0.11')
})

test('wallet funds never substitute for an empty or insufficient Gateway balance', () => {
  const walletUsdc = '50'
  assert.ok(Number(walletUsdc) > 0.1)
  assert.equal(gatewayCanPay('0', '110000'), false)
  assert.equal(gatewayCanPay('0.109999', '110000'), false)
  assert.match(insufficientGatewayMessage('110000'), /wallet has USDC[\s\S]*Circle Gateway balance[\s\S]*Fund Mahshar Balance/i)
})

test('Gateway exact required amount and greater balances are accepted', () => {
  assert.equal(gatewayCanPay('0.110000', '110000'), true)
  assert.equal(gatewayCanPay('1', '110000'), true)
})
