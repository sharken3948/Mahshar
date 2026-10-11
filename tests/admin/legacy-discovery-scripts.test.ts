import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

function runScript(path: string, args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', path, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      NODE_ENV: 'test',
      PATH: process.env.PATH,
      NODE_PATH: process.env.NODE_PATH,
    },
  })
}

test('activate-verified rejects its write-enabled mode before environment loading', () => {
  const result = runScript('scripts/activate-verified.mts', ['--live'])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /^legacy_discovery_disabled\s*$/)
  assert.doesNotMatch(result.stdout + result.stderr, /\[env\]|SUPABASE|Report not found|Activating/)
})

test('recover-html-docs requires explicit read-only mode before environment loading', () => {
  const result = runScript('scripts/recover-html-docs.mts', [])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /^legacy_discovery_disabled: pass --dry-run for read-only analysis\s*$/)
  assert.doesNotMatch(result.stdout + result.stderr, /\[env\]|SUPABASE|Report not found|html_docs rows/)
})
