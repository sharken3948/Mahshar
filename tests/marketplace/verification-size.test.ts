import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { assessRepresentativeResponseSize, MAX_SAFE_SERIALIZED_RESPONSE_BYTES,
  VERIFICATION_RESPONSE_WARNING_BYTES } from '../../src/lib/proxy-response'

test('verification size policy accepts small, warns near the cap, and blocks over-limit samples', () => {
  const small = assessRepresentativeResponseSize({ ok: true })
  assert.deepEqual({ warning: small.warning, blocked: small.exceedsLimit }, { warning: false, blocked: false })
  const warning = assessRepresentativeResponseSize('x'.repeat(VERIFICATION_RESPONSE_WARNING_BYTES))
  assert.equal(warning.warning, true)
  assert.equal(warning.exceedsLimit, false)
  const over = assessRepresentativeResponseSize('x'.repeat(MAX_SAFE_SERIALIZED_RESPONSE_BYTES))
  assert.equal(over.exceedsLimit, true)
})

test('both verification paths block size before granting verified state', () => {
  const direct = readFileSync('src/app/api/apis/[id]/verify/route.ts', 'utf8')
  assert.ok(direct.indexOf('if (size.exceedsLimit)') < direct.indexOf("update({ verified_at:"))
  const score = readFileSync('src/app/api/ai/score/route.ts', 'utf8')
  assert.ok(score.indexOf('if (rawResponseTooLarge || responseSizeBlocked)') < score.indexOf('updates.verified_at'))
  assert.match(score, /Verification response is near Mahshar\\'s delivery size limit; larger responses may fail/)
})
