import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'

test('admin UI uses the centralized wallet session request path', () => {
  const provider = readFileSync('src/components/AdminAccess.tsx', 'utf8')
  assert.match(provider, /useMarketplaceSession/)
  assert.match(provider, /AdminRequest\.Provider/)
  assert.doesNotMatch(provider, /Verify wallet|Sign in|ConnectButton|AdminAccessMessage/)
})

test('admin source does not expose a client-side admin secret or wallet allowlist', () => {
  for (const file of ['src/components/AdminAccess.tsx','src/app/admin/layout.tsx',
    'src/app/admin/discovery/page.tsx','src/app/admin/discovery/listings/page.tsx','next.config.ts']) {
    const source = readFileSync(file, 'utf8')
    assert.doesNotMatch(source, /NEXT_PUBLIC_ADMIN|ADMIN_SECRET|x-admin-key/)
  }
})
