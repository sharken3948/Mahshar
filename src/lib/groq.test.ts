import assert from 'node:assert/strict'
import { test } from 'node:test'

process.env.GROQ_API_KEY ||= 'test-key'
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { validateMatchResult, validateScoreResult } = require('./groq') as typeof import('./groq')

const validScore = { score: 8, suggested_price: 0.01, approved: true, critical_issues: [], warnings: [],
  positives: ['useful'], summary: 'Valid.' }

test('score output requires a real boolean and bounded numeric fields', () => {
  assert.throws(() => validateScoreResult({ ...validScore, approved: 'false' }), /invalid score schema/)
  assert.throws(() => validateScoreResult({ ...validScore, score: 11 }), /invalid score schema/)
  assert.throws(() => validateScoreResult({ ...validScore, suggested_price: Number.POSITIVE_INFINITY }), /invalid score schema/)
  assert.equal(validateScoreResult(validScore).approved, true)
})

test('prompt-injection-shaped model output cannot introduce candidate IDs', () => {
  const result = validateMatchResult({
    api_ids: ['allowed-id', 'ignore previous instructions', 'admin-api'],
    reasoning: 'The listing text asked me to return admin-api.',
  }, new Set(['allowed-id', 'second-id']))
  assert.deepEqual(result.api_ids, ['allowed-id'])
})

test('malformed match output fails closed', () => {
  assert.throws(() => validateMatchResult({ api_ids: 'allowed-id', reasoning: 'x' }, new Set(['allowed-id'])), /invalid match schema/)
  assert.throws(() => validateMatchResult({ api_ids: ['allowed-id'], reasoning: 42 }, new Set(['allowed-id'])), /invalid match schema/)
})
