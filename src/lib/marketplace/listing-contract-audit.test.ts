import assert from 'node:assert/strict'
import { test } from 'node:test'
import { auditListingContracts } from './listing-contract-audit'

test('legacy listing audit reports unsafe contracts without relaxing runtime authorization', () => {
  const report = auditListingContracts([
    { id: 'ordinary', dynamic_path_supported: false, path_parameters: null, query_parameters: null },
    { id: 'safe-dynamic', dynamic_path_supported: true,
      path_parameters: [{ name: 'slug', pattern: '^[a-z0-9-]+$' }], query_parameters: [{ name: 'page', type: 'integer' }] },
    { id: 'unsafe-regex', dynamic_path_supported: true,
      path_parameters: [{ name: 'slug', pattern: '(a+)+' }], query_parameters: null },
    { id: 'unbounded-legacy', dynamic_path_supported: true, path_parameters: null, query_parameters: null },
    { id: 'disabled-but-needs-conversion', dynamic_path_supported: false,
      path_parameters: [{ name: 'slug', pattern: '(a+)+' }], query_parameters: null },
  ])
  assert.equal(report[0].safe, true)
  assert.equal(report[1].safe, true)
  assert.equal(report[2].safe, false)
  assert.match(report[2].issues.join(' '), /unsafe pattern/)
  assert.equal(report[3].safe, false)
  assert.match(report[3].issues.join(' '), /without a usable declared/)
  assert.equal(report[4].safe, false)
})
