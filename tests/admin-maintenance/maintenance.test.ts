import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { chdir, cwd } from 'node:process'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { compareVersions, checkMaintenanceUpdates, evaluateArcNotice, evaluateArcRelease, evaluateGroqModel, groqDeprecationForModel, maintenanceInventoryDashboard, maintenanceSummary, validGroqDeprecationDocument } from '../../src/lib/admin-maintenance/checks'
import { getMaintenanceInventory } from '../../src/lib/admin-maintenance/inventory'
import { OFFICIAL_ARC_MAINNET_RPC_URL } from '../../src/lib/arc-network'
import type { MaintenanceCheckResult, MaintenanceInventoryItem, MaintenanceSeverity, MaintenanceStatus } from '../../src/lib/admin-maintenance/types'

const fixedTime = '2026-10-09T10:00:00.000Z'
const baseItem = (overrides: Partial<MaintenanceInventoryItem> = {}): MaintenanceInventoryItem => ({
  id: 'fixture', component: 'Fixture', category: 'Runtime', current: '1.2.3', package_name: 'fixture',
  usage: 'Synthetic test-only usage.', source_url: 'https://www.npmjs.com/package/fixture', ...overrides,
})

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

test('installed inventory is derived from the lockfile and current runtime configuration', () => {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as { dependencies: Record<string, string> }
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8')) as { packages: Record<string, { version?: string }> }
  const inventory = getMaintenanceInventory()
  for (const packageItem of inventory.filter(item => item.package_name)) {
    assert.equal(packageItem.current, lock.packages[`node_modules/${packageItem.package_name}`]?.version)
  }
  assert.equal(inventory.find(item => item.id === 'groq-model')?.current, process.env.GROQ_MODEL?.trim() || 'openai/gpt-oss-120b')
  assert.match(inventory.find(item => item.id === 'arc-rpc')?.current || '', /browser role: official \.arc\.io Mainnet RPC/)
  assert.equal(manifest.dependencies['@circle-fin/bridge-kit'], '^1.10.2')
  assert.equal(inventory.find(item => item.id === 'circle-bridge-kit')?.current, '1.15.1')
  assert.equal(manifest.dependencies['@circle-fin/onramp-kit'], '1.0.3')
  assert.equal(inventory.find(item => item.id === 'circle-onramp')?.current, '1.0.3')
  assert.ok(inventory.some(item => item.id === 'circle-unified-balance'))
  assert.ok(inventory.some(item => item.id === 'circle-x402'))
})

test('inventory is build-time bundled and does not require repository files at runtime', () => {
  const originalCwd = cwd()
  const expectedNext = (JSON.parse(readFileSync('package-lock.json', 'utf8')) as { packages: Record<string, { version?: string }> })
    .packages['node_modules/next']?.version
  try {
    chdir(tmpdir())
    const inventory = getMaintenanceInventory()
    assert.equal(inventory.find(item => item.id === 'next')?.current, expectedNext)
    assert.ok(inventory.some(item => item.id === 'groq-model'))
    assert.ok(inventory.some(item => item.id === 'arc-rpc'))
  } finally { chdir(originalCwd) }

  const source = readFileSync('src/lib/admin-maintenance/inventory.ts', 'utf8')
  assert.match(source, /import lockfileJson from '\.\.\/\.\.\/\.\.\/package-lock\.json'/)
  assert.doesNotMatch(source, /readFileSync|process\.cwd|node:fs|node:path/)
})

test('server inventory imports the official Arc RPC from a boundary-neutral module', () => {
  const inventorySource = readFileSync('src/lib/admin-maintenance/inventory.ts', 'utf8')
  const networkSource = readFileSync('src/lib/arc-network.ts', 'utf8')
  const clientSource = readFileSync('src/lib/arc-balance-client.ts', 'utf8')
  assert.equal(typeof OFFICIAL_ARC_MAINNET_RPC_URL, 'string')
  assert.equal(OFFICIAL_ARC_MAINNET_RPC_URL, 'https://rpc.mainnet.arc.io/')
  assert.match(inventorySource, /from '@\/lib\/arc-network'/)
  assert.doesNotMatch(inventorySource, /from '@\/lib\/arc-balance-client'/)
  assert.doesNotMatch(networkSource, /^['"]use client['"]/m)
  assert.match(clientSource, /from '@\/lib\/arc-network'/)
})

test('one broken package inventory entry does not erase unrelated components', () => {
  const packages = new Proxy({} as Record<string, { version?: string }>, {
    get: (_target, key) => {
      if (key === 'node_modules/next') throw new Error('synthetic package metadata failure')
      if (key === 'node_modules/react') return { version: '9.9.9-test' }
      return undefined
    },
  })
  const inventory = getMaintenanceInventory({ packages })
  assert.equal(inventory.find(item => item.id === 'next')?.current, 'Unknown')
  assert.equal(inventory.find(item => item.id === 'react')?.current, '9.9.9-test')
  assert.ok(inventory.some(item => item.id === 'groq-model'))
  assert.ok(inventory.some(item => item.id === 'arc-rpc'))
})

test('newer and current semantic versions are detected deterministically', () => {
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0)
  assert.equal(compareVersions('1.2.3', '1.2.4'), -1)
  assert.equal(compareVersions('2.0.0', '1.9.9'), 1)
  assert.equal(compareVersions('not-a-version', '1.0.0'), null)
  assert.equal(compareVersions('1.0.0-beta.2', '1.0.0-beta.10'), -1)
  assert.equal(compareVersions('1.0.0-beta.10', '1.0.0'), -1)
  assert.equal(compareVersions('1.0.0-1', '1.0.0-alpha'), -1)
  assert.equal(compareVersions('1.0.0+build.1', '1.0.0+build.2'), 0)
  assert.equal(compareVersions('1.0.0-01', '1.0.0-1'), null)
})

test('package update severity is conservative for patch, minor, and major releases', async () => {
  const inventory = [
    baseItem({ id: 'patch', package_name: 'patch' }), baseItem({ id: 'minor', package_name: 'minor' }),
    baseItem({ id: 'major', package_name: 'major' }),
  ]
  const versions = { patch: '1.2.4', minor: '1.3.0', major: '2.0.0' } as const
  const fetcher = (async (input: string | URL | Request) => {
    const name = decodeURIComponent(new URL(String(input)).pathname.split('/')[1]) as keyof typeof versions
    return response({ version: versions[name] })
  }) as typeof fetch
  const results = (await checkMaintenanceUpdates({ inventory, fetch: fetcher, now: () => new Date(fixedTime) })).results
  assert.deepEqual(results.map(item => [item.id, item.status, item.severity]), [
    ['patch', 'update_available', 'Info'], ['minor', 'update_available', 'Review'], ['major', 'update_available', 'Review'],
  ])
})

test('one failed official source does not prevent other component checks', async () => {
  const inventory = [baseItem({ id: 'failed', package_name: 'failed' }), baseItem({ id: 'healthy', component: 'Healthy', package_name: 'healthy' })]
  const fetcher = (async (input: string | URL | Request) => String(input).includes('/failed/') ? response({}, 503) : response({ version: '1.2.4' })) as typeof fetch
  const dashboard = await checkMaintenanceUpdates({ inventory, fetch: fetcher, now: () => new Date(fixedTime) })
  assert.equal(dashboard.results.find(item => item.id === 'failed')?.status, 'check_failed')
  assert.equal(dashboard.results.find(item => item.id === 'healthy')?.status, 'update_available')
  assert.equal(dashboard.summary.check_failures, 1)
})

test('all official adapters fail independently for network, malformed, timeout, redirect, and size errors', async () => {
  const inventory = [
    baseItem({ id: 'npm-unavailable', package_name: 'npm-unavailable' }),
    baseItem({ id: 'malformed', package_name: 'malformed' }),
    baseItem({ id: 'overflow', package_name: 'overflow' }),
    baseItem({ id: 'timeout', package_name: 'timeout' }),
    baseItem({ id: 'redirect', package_name: 'redirect' }),
    baseItem({ id: 'healthy', package_name: 'healthy' }),
    baseItem({ id: 'arc-node', category: 'Arc', package_name: null }),
    baseItem({ id: 'arc-rpc', category: 'Arc', package_name: null }),
    baseItem({ id: 'groq-model', category: 'AI', current: 'model', package_name: null }),
    baseItem({ id: 'groq-deprecations', category: 'AI', current: 'model', package_name: null, source_url: 'https://console.groq.com/docs/deprecations.md' }),
  ]
  const officialHosts = new Set(['registry.npmjs.org', 'api.github.com', 'status.arc.io', 'api.groq.com', 'console.groq.com'])
  const previous = process.env.GROQ_API_KEY
  process.env.GROQ_API_KEY = 'synthetic-test-key'
  try {
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input)); assert.equal(officialHosts.has(url.hostname), true)
      assert.equal(init?.redirect, 'error')
      if (url.pathname.includes('healthy')) return response({ version: '1.2.3' })
      if (url.pathname.includes('malformed')) return new Response('{not-json')
      if (url.pathname.includes('overflow')) return response({ version: 'x'.repeat(256_001) })
      if (url.pathname.includes('timeout')) { assert.ok(init?.signal instanceof AbortSignal); throw new DOMException('Timed out', 'AbortError') }
      if (url.pathname.includes('redirect')) throw new TypeError('redirect rejected')
      return response({ error: 'synthetic upstream failure' }, 503)
    }) as typeof fetch
    const dashboard = await checkMaintenanceUpdates({ inventory, fetch: fetcher, now: () => new Date(fixedTime) })
    assert.equal(dashboard.results.find(item => item.id === 'healthy')?.status, 'current')
    for (const item of dashboard.results.filter(item => item.id !== 'healthy')) {
      assert.equal(item.status, 'check_failed', item.id)
      assert.equal(item.latest, null, item.id)
      assert.doesNotMatch(JSON.stringify(item), /synthetic upstream failure|not-json/)
    }
  } finally {
    if (previous === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = previous
  }
})

test('configured Groq model unavailable is Critical and available is current', () => {
  const item = baseItem({ id: 'groq-model', component: 'Configured Groq model', category: 'AI', current: 'openai/gpt-oss-120b', package_name: null })
  assert.equal(evaluateGroqModel(item, ['another/model'], fixedTime).severity, 'Critical')
  assert.equal(evaluateGroqModel(item, ['openai/gpt-oss-120b'], fixedTime).status, 'current')
})

test('empty Groq model metadata and malformed deprecation documents fail as checks, not availability claims', async () => {
  const previous = process.env.GROQ_API_KEY
  process.env.GROQ_API_KEY = 'synthetic-test-key'
  try {
    const inventory = [
      baseItem({ id: 'groq-model', category: 'AI', current: 'configured/model', package_name: null }),
      baseItem({ id: 'groq-deprecations', category: 'AI', current: 'configured/model', package_name: null, source_url: 'https://console.groq.com/docs/deprecations.md' }),
    ]
    const fetcher = (async (input: string | URL | Request) => String(input).includes('/models') ? response({ data: [] }) : new Response('<html>temporary error page</html>')) as typeof fetch
    const results = (await checkMaintenanceUpdates({ inventory, fetch: fetcher, now: () => new Date(fixedTime) })).results
    assert.deepEqual(results.map(item => item.status), ['check_failed', 'check_failed'])
    assert.deepEqual(results.map(item => item.severity), ['Review', 'Review'])
  } finally {
    if (previous === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = previous
  }
})

test('Groq deprecation parsing checks only the deprecated-model column', () => {
  const markdown = [
    'Deprecated Model | Shutdown Date | Recommended Replacement Model ID',
    '--- | --- | ---',
    '`old/model` | 11/01/26 | `openai/gpt-oss-120b`',
  ].join('\n')
  assert.deepEqual(groqDeprecationForModel(markdown, 'old/model'), { deprecated: true, shutdown: '11/01/26' })
  assert.deepEqual(groqDeprecationForModel(markdown, 'openai/gpt-oss-120b'), { deprecated: false, shutdown: null })
  assert.deepEqual(groqDeprecationForModel('`old/model` | secret-shaped arbitrary text | replacement', 'old/model'), { deprecated: true, shutdown: null })
  assert.equal(validGroqDeprecationDocument(markdown), true)
  assert.equal(validGroqDeprecationDocument('<html>temporary error page</html>'), false)
})

test('Arc releases retry the official public API when an optional GitHub token is rejected', async () => {
  const previous = process.env.GITHUB_TOKEN
  process.env.GITHUB_TOKEN = 'stale-synthetic-token'
  try {
    const item = baseItem({ id: 'arc-node', component: 'Arc node releases', category: 'Arc', current: 'RPC consumer (no Mahshar node)', package_name: null })
    const requests: Array<{ url: string; authorization: string | null }> = []
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      requests.push({ url: String(input), authorization: headers.get('authorization') })
      if (headers.has('authorization')) return response({ message: 'Bad credentials' }, 401)
      return response({ tag_name: 'v0.8.1', body: 'Node-only consensus release.' })
    }) as typeof fetch
    const result = (await checkMaintenanceUpdates({ inventory: [item], fetch: fetcher, now: () => new Date(fixedTime) })).results[0]
    assert.equal(result.status, 'current')
    assert.equal(result.latest, 'v0.8.1')
    assert.deepEqual(requests, [
      { url: 'https://api.github.com/repos/circlefin/arc-node/releases/latest', authorization: 'Bearer stale-synthetic-token' },
      { url: 'https://api.github.com/repos/circlefin/arc-node/releases/latest', authorization: null },
    ])
  } finally {
    if (previous === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = previous
  }
})

test('Groq deprecations use the bounded official Markdown source', async () => {
  const item = baseItem({
    id: 'groq-deprecations', category: 'AI', current: 'openai/gpt-oss-120b', package_name: null,
    source_url: 'https://console.groq.com/docs/deprecations.md',
  })
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), 'https://console.groq.com/docs/deprecations.md')
    assert.equal(new Headers(init?.headers).get('accept'), 'text/markdown')
    return new Response([
      '| Deprecated Model | Shutdown Date | Recommended Replacement Model ID |',
      '| --- | --- | --- |',
      '| llama-3.3-70b-versatile | 08/16/26 | openai/gpt-oss-120b |',
    ].join('\n'), { headers: { 'content-type': 'text/markdown; charset=utf-8' } })
  }) as typeof fetch
  const result = (await checkMaintenanceUpdates({ inventory: [item], fetch: fetcher, now: () => new Date(fixedTime) })).results[0]
  assert.equal(result.status, 'current')
  assert.equal(result.latest, 'No matching notice')
})

test('summary counts derive from normalized statuses and severities', () => {
  const item = (status: MaintenanceStatus, severity: MaintenanceSeverity): MaintenanceCheckResult => ({ ...baseItem(), latest: null, status, severity, impact: '', details: '', recommended_action: '', checked_at: fixedTime })
  assert.deepEqual(maintenanceSummary([
    item('action_required', 'Critical'), item('deprecation_notice', 'Important'), item('update_available', 'Review'),
    item('current', 'Info'), item('check_failed', 'Review'), item('unknown', 'Info'),
  ]), { critical: 1, important: 1, review: 2, current: 1, check_failures: 1 })
})

test('Arc Testnet legacy RPC notice is irrelevant to current Mainnet configuration', () => {
  const item = baseItem({ id: 'arc-rpc', component: 'Arc operational notices', category: 'Arc', current: 'https://rpc.mainnet.arc.io/', package_name: null })
  const result = evaluateArcNotice(item, {
    id: 'arc-v081-fixture', title: 'Arc v0.8.1 — Testnet arc.network RPC URL deprecation',
    body: 'Legacy Arc Testnet https://rpc.testnet.arc.network URLs are being deprecated.',
    url: 'https://status.arc.io/', updatedAt: fixedTime,
  }, 'https://rpc.mainnet.arc.io')
  assert.equal(result.status, 'current')
  assert.equal(result.severity, 'Info')
  assert.match(result.impact, /No Mahshar action required/)
})

test('Arc release notes distinguish node-only and application-facing RPC changes', () => {
  const item = baseItem({ id: 'arc-node', component: 'Arc node releases', category: 'Arc', current: 'RPC consumer (no Mahshar node)', package_name: null })
  assert.equal(evaluateArcRelease(item, 'v0.8.1', 'Fix consensus precompile gas accounting.', fixedTime).severity, 'Info')
  const rpcFacing = evaluateArcRelease(item, 'v0.8.2', 'JSON-RPC error response format changed.', fixedTime)
  assert.equal(rpcFacing.status, 'current')
  assert.equal(rpcFacing.severity, 'Review')
})

test('a Mainnet arc.network notice is never dismissed as a Testnet-only notice', () => {
  const item = baseItem({ id: 'arc-rpc', component: 'Arc RPC', category: 'Arc', current: 'Mainnet RPC roles', package_name: null })
  const result = evaluateArcNotice(item, { id: 'mainnet', title: 'Arc Mainnet endpoint deprecation', body: 'Legacy rpc.mainnet.arc.network will be retired.', url: 'https://status.arc.io/', updatedAt: fixedTime }, ['https://rpc.mainnet.arc.io'])
  assert.equal(result.status, 'action_required')
  assert.equal(result.severity, 'Important')
  assert.doesNotMatch(result.impact, /No Mahshar action required/)
})

test('a notice naming the configured endpoint is Critical and actionable', () => {
  const item = baseItem({ id: 'arc-rpc', component: 'Arc RPC', category: 'Arc', current: 'Configured Mainnet RPC', package_name: null })
  const result = evaluateArcNotice(item, { id: 'relevant', title: 'RPC endpoint retirement', body: 'https://rpc.mainnet.arc.io will be deprecated.', url: 'https://status.arc.io/', updatedAt: fixedTime }, 'https://rpc.mainnet.arc.io')
  assert.equal(result.status, 'action_required')
  assert.equal(result.severity, 'Critical')
})

test('inventory and check results expose no configured secrets', () => {
  const previous = { groq: process.env.GROQ_API_KEY, github: process.env.GITHUB_TOKEN, rpc: process.env.ARC_MAINNET_RPC_URL }
  try {
    process.env.GROQ_API_KEY = 'synthetic-secret-groq-value'
    process.env.GITHUB_TOKEN = 'synthetic-secret-github-value'
    process.env.ARC_MAINNET_RPC_URL = 'https://private-user:private-pass@rpc.example.test/secret-path?token=hidden'
    const serialized = JSON.stringify(maintenanceInventoryDashboard())
    for (const secret of ['synthetic-secret-groq-value', 'synthetic-secret-github-value', 'private-user', 'private-pass', 'rpc.example.test', 'secret-path', 'token=hidden']) assert.equal(serialized.includes(secret), false)
    const notice = evaluateArcNotice(baseItem({ category: 'Arc' }), { id: 'secret', title: 'Operational notice', body: 'private upstream body secret', url: 'https://status.arc.io/', updatedAt: fixedTime }, 'https://rpc.mainnet.arc.io')
    assert.doesNotMatch(JSON.stringify(notice), /private upstream body secret/)
  } finally {
    if (previous.groq === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = previous.groq
    if (previous.github === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = previous.github
    if (previous.rpc === undefined) delete process.env.ARC_MAINNET_RPC_URL; else process.env.ARC_MAINNET_RPC_URL = previous.rpc
  }
})

test('Maintenance UI is manual-refresh-only and has no update or mutation path', () => {
  const client = readFileSync('src/app/admin/maintenance/maintenance-client.tsx', 'utf8')
  const route = readFileSync('src/app/api/admin/maintenance/route.ts', 'utf8')
  const shell = readFileSync('src/app/admin/operations/operations-shell.tsx', 'utf8')
  assert.match(client, /'Check for updates'/)
  assert.match(client, /useEffect\(\(\) => \{ void loadInventory\(\) \}/)
  assert.doesNotMatch(client, /useEffect\([\s\S]{0,180}check\(\)/)
  assert.doesNotMatch(client, /setInterval|Update package|Apply update/)
  assert.doesNotMatch(route, /npm|migration|deploy|process\.env\s*=|sendOutreach/)
  assert.match(shell, /href: '\/admin\/maintenance'/)
})
