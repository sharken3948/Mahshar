import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkMaintenanceUpdates } from '../../src/lib/admin-maintenance/checks'
import { getAdvisoryScope, getMaintenanceInventory, MAX_ADVISORY_PACKAGES } from '../../src/lib/admin-maintenance/inventory'

const checkedAt = new Date('2026-10-31T12:00:00Z')
const inventory = getMaintenanceInventory()
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const markdown = (value: string) => new Response(value, { headers: { 'content-type': 'text/markdown' } })
const run = (ids: string[], fetcher: typeof fetch) => checkMaintenanceUpdates({
  inventory: inventory.filter(item => ids.includes(item.id)), fetch: fetcher, now: () => checkedAt,
})
const cctpNotice = 'CCTP V1 (Legacy) deprecation begins October 31, 2026 and completes on December\n1, 2026, in favor of CCTP V2.'

test('x402 and MCP installed packages are included without substituting package names for protocol evidence', () => {
  for (const id of ['x402-core', 'x402-evm', 'mcp-server', 'mcp-core']) {
    assert.match(inventory.find(item => item.id === id)?.current || '', /^\d+\.\d+\.\d+$/)
  }
  assert.match(inventory.find(item => item.id === 'cctp-notices')?.current || '', /Bridge Kit 1\.15\.1; CCTP provider 1\.14\.0/)
})

test('CCTP deadline is sourced from the phase-out announcement, with applicability left for review', async () => {
  const report = await run(['cctp-notices'], (async (input, init) => {
    assert.equal(String(input), 'https://developers.circle.com/cctp/migration-from-v1-to-v2.md')
    assert.equal(init?.redirect, 'error')
    assert.equal(init?.cache, 'no-store')
    assert.ok(init?.signal)
    return markdown('Unrelated notice: December 31, 2099.\n' + cctpNotice)
  }) as typeof fetch)
  const result = report.results[0]
  assert.equal(result.deadline, '2026-12-01')
  assert.equal(result.status, 'deprecation_notice')
  assert.equal(result.action, 'review')
  assert.equal(result.severity, 'Important')
  assert.doesNotMatch(result.impact, /No action required|uses V2/)
  assert.match(result.recommended_action, /pending-transfer recovery/)
  const future = cctpNotice.replaceAll('2026', '2027')
  assert.equal((await run(['cctp-notices'], (async () => markdown(future)) as typeof fetch)).results[0].deadline, '2027-12-01')
})

test('MCP and ERC announcements use verified formats and constructed official links, never remote link targets', async () => {
  const sha = 'a'.repeat(40)
  const report = await run(['mcp-protocol', 'erc-8004'], (async input => {
    if (String(input).includes('modelcontextprotocol')) return json({ tag_name: '2026-07-28', html_url: 'https://untrusted.invalid/' })
    return json([{ sha, commit: { message: 'Specification changes\nMore text', committer: { date: '2026-10-01T01:00:00Z' } } }])
  }) as typeof fetch)
  assert.deepEqual(report.results.map(result => result.action), ['review', 'review'])
  assert.equal(report.results[0].source_url, 'https://github.com/modelcontextprotocol/modelcontextprotocol/releases/tag/2026-07-28')
  assert.equal(report.results[1].source_url, `https://github.com/ethereum/ERCs/commit/${sha}`)
  assert.match(report.results[1].details, /no pinned specification revision/)
})

test('unrecognized protocol formats fail independently rather than reporting compatibility', async () => {
  const report = await run(['cctp-notices', 'mcp-protocol', 'erc-8004', 'x402-core'], (async input => {
    const url = String(input)
    if (url.includes('circle.com')) return markdown('CCTP V1 no longer available; see a new source.')
    if (url.includes('modelcontextprotocol')) return json({ tag_name: '2026-02-30' })
    if (url.includes('ERCs')) return json([{ sha: '../../untrusted', commit: {} }])
    return json({ version: '2.15.1' })
  }) as typeof fetch)
  assert.equal(report.summary.check_failures, 3)
  assert.equal(report.results.find(item => item.id === 'x402-core')?.action, 'optional')
})

test('protocol and advisory requests share the existing bounded failure handling', async () => {
  for (const mode of ['timeout', 'oversized', 'wrong-type', 'unavailable']) {
    const report = await run(['cctp-notices', 'mcp-protocol', 'erc-8004', 'security-advisories'], (async (_input, init) => {
      assert.equal(init?.redirect, 'error')
      assert.ok(init?.signal instanceof AbortSignal)
      if (mode === 'timeout') throw new DOMException('private upstream error', 'AbortError')
      if (mode === 'oversized') return new Response('x'.repeat(256_001), { headers: { 'content-type': 'application/json' } })
      if (mode === 'wrong-type') return new Response('<html>upstream error</html>', { headers: { 'content-type': 'text/html' } })
      return new Response('private upstream error', { status: 503 })
    }) as typeof fetch)
    assert.equal(report.summary.check_failures, 4, mode)
    assert.doesNotMatch(JSON.stringify(report), /private upstream error/)
  }
})

test('advisory scope uses exact public production versions including nested duplicates and reports omissions', () => {
  const scope = getAdvisoryScope()
  assert.equal(scope.complete, true)
  assert.ok(scope.packages.some(item => item.name === '@supabase/supabase-js'))
  assert.ok(scope.packages.some(item => item.name === '@x402/evm'))
  assert.ok(scope.packages.some(item => item.name === '@circle-fin/provider-cctp-v2'))
  assert.equal(scope.packages.some(item => item.name === 'typescript'), false)
  const record = (version: string) => ({ version, resolved: 'https://registry.npmjs.org/fixture/-/fixture.tgz' })
  const nested = getAdvisoryScope({ packages: {
    '': { dependencies: { fixture: '1.0.0', private: '1.0.0' } },
    'node_modules/fixture': record('1.0.0'),
    'node_modules/parent/node_modules/fixture': record('2.0.0'),
    'node_modules/dev/node_modules/fixture': { ...record('3.0.0'), dev: true },
    'node_modules/private': { version: '1.0.0', resolved: 'https://private.invalid/package' },
  } })
  assert.deepEqual(nested.packages, [{ name: 'fixture', version: '1.0.0' }, { name: 'fixture', version: '2.0.0' }])
  assert.equal(nested.complete, false)
  const large = getAdvisoryScope({ packages: {
    '': { dependencies: { fixture: '*' } },
    ...Object.fromEntries(Array.from({ length: 150 }, (_, index) => [`node_modules/p${index}/node_modules/fixture`, record(`1.0.${index}`)])),
  } })
  assert.equal(large.packages.length, MAX_ADVISORY_PACKAGES)
  assert.equal(large.complete, false)
})

test('security lookup sends only exact name/version pairs and surfaces matched advisories with scope caveats', async () => {
  const scope = getAdvisoryScope()
  const report = await run(['security-advisories'], (async (input, init) => {
    assert.equal(String(input), 'https://api.osv.dev/v1/querybatch')
    assert.equal(init?.method, 'POST')
    const body = JSON.parse(String(init?.body))
    assert.deepEqual(body, { queries: scope.packages.map(({ name, version }) => ({ package: { ecosystem: 'npm', name }, version })) })
    return json({ results: scope.packages.map((_, index) => index === 0 ? { vulns: [{ id: 'GHSA-abcd-1234-efgh' }] } : {}) })
  }) as typeof fetch)
  const finding = report.results[1]
  assert.equal(finding.current, scope.packages[0].version)
  assert.equal(finding.action, 'required')
  assert.equal(finding.source_url, 'https://github.com/advisories/GHSA-abcd-1234-efgh')
  assert.match(finding.impact, /exploitability has not been established/)
  assert.match(report.results[0].details, /Other transitive and development dependencies are outside/)
})

test('empty, incomplete, malformed, and truncated advisory responses never imply a clean security audit', async () => {
  const scope = getAdvisoryScope()
  const clean = await run(['security-advisories'], (async () => json({ results: scope.packages.map(() => ({})) })) as typeof fetch)
  assert.match(clean.results[0].impact, /not a security or compatibility guarantee/)
  const paged = await run(['security-advisories'], (async () => json({ results: scope.packages.map(() => ({ next_page_token: 'more' })) })) as typeof fetch)
  assert.equal(paged.results[0].status, 'unknown')
  const truncated = await run(['security-advisories'], (async () => json({ results: scope.packages.map(() => ({ vulns: [{ id: 'TEST-1234' }] })) })) as typeof fetch)
  assert.equal(truncated.results.length, 21)
  assert.equal(truncated.results[0].status, 'unknown')
  for (const data of [{}, { results: [] }, { results: scope.packages.map(() => ({ vulns: null })) }, { results: scope.packages.map(() => ({ vulns: [{ id: '../untrusted' }] })) }]) {
    const failed = await run(['security-advisories'], (async () => json(data)) as typeof fetch)
    assert.equal(failed.results[0].status, 'check_failed')
  }
})

test('being current on npm does not establish compatibility, while ordinary updates remain optional', async () => {
  const current = inventory.find(item => item.id === 'x402-core')!.current
  const result = (await run(['x402-core'], (async () => json({ version: current })) as typeof fetch)).results[0]
  assert.equal(result.status, 'current')
  assert.equal(result.action, 'review')
  assert.doesNotMatch(result.recommended_action, /No action required/)
})
