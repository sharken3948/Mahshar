import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { test } from 'node:test'
import { isSafeParameterPattern, matchesSafeParameterPattern } from './safe-pattern'

test('rejects nested quantifiers, alternation, groups, lookarounds, and backreferences', () => {
  for (const pattern of ['(a+)+', '(a|aa)+', '(?:a+)+', '(?=a)a', '(a)\\1', '([a-z]+)*']) {
    assert.equal(isSafeParameterPattern(pattern), false, pattern)
  }
})

test('matches the supported deterministic path and query pattern subset', () => {
  for (const [pattern, value] of [
    ['^[a-z0-9-]+$', 'user-42'],
    ['\\d+', '420'],
    ['[A-Za-z_][A-Za-z0-9_]{0,31}', 'safe_name'],
    ['v[12]?', 'v2'],
    ['.*', 'bounded-value'],
  ]) assert.equal(matchesSafeParameterPattern(pattern, value), true, `${pattern} ${value}`)
  assert.equal(matchesSafeParameterPattern('\\d+', '12x'), false)
})

test('hostile patterns fail closed within a practical bounded duration', () => {
  const started = performance.now()
  for (let index = 0; index < 1_000; index++) {
    assert.equal(matchesSafeParameterPattern('(a+)+', `${'a'.repeat(2048)}!`), false)
    assert.equal(matchesSafeParameterPattern('(a|aa)+', `${'a'.repeat(2048)}!`), false)
  }
  assert.ok(performance.now() - started < 500)
})

