import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (path: string) => readFileSync(path, 'utf8')

test('Providers presents exact current economics without promising provider outcomes', () => {
  const providers = read('src/app/providers/page.tsx')
  for (const statement of [
    'You set the listed base price per call.',
    'Buyers currently pay that price plus 10%',
    '90% of the listed base price as your seller share',
    'No listing, publication, or subscription fee',
    'Minimum seller withdrawal: 1 USDC.',
    'Estimated Arc gas is deducted from the requested withdrawal amount.',
    '1.00 USDC', '1.10 USDC', '0.90 USDC', 'before withdrawal gas',
  ]) assert.ok(providers.includes(statement), statement)
  assert.doesNotMatch(providers, /you keep most|profit|revenue after all costs|guaranteed (?:revenue|customers|distribution)/i)
})

test('Provider onboarding and FAQ copy matches the implemented responsibility split', () => {
  const providers = read('src/app/providers/page.tsx')
  const docs = read('src/app/docs/page.tsx')
  const support = read('src/app/support/page.tsx')
  const seller = read('src/app/seller/page.tsx')

  for (const statement of [
    'EVM wallet', 'may select Arc Mainnet', 'signature to sign in',
    'one real representative request', 'another representative request',
    'upstream availability, quotas, capacity', 'edit or deactivate',
  ]) assert.ok(providers.includes(statement), statement)
  assert.match(seller, /Connect an EVM wallet/)
  assert.match(seller, /representative request/)
  assert.match(docs, /seller share is 90%/)
  assert.match(docs, /rounded to the nearest micro-USDC \(0\.000001 USDC\)/)
  assert.match(docs, /minimum withdrawal is 1 USDC/)
  assert.match(docs, /provider remains responsible for upstream availability, quota, and capacity/)
  assert.match(support, /single support address/)
  assert.equal((support.match(/support@mahshar\.xyz/g) ?? []).length >= 2, true)
})

test('Credential claims state the verified protection boundaries without absolute guarantees', () => {
  const providers = read('src/app/providers/page.tsx')
  const docs = read('src/app/docs/page.tsx')
  assert.match(providers, /encrypted before database storage/)
  assert.match(providers, /not returned after storage/)
  assert.match(providers, /decrypts them server-side only where analysis, verification, or proxy execution requires them/)
  assert.match(docs, /AES-256-GCM/)
  assert.doesNotMatch(`${providers}\n${docs}`, /zero risk|impossible exposure|security audit|certified/i)
})

test('Marketplace endpoint status avoids provider-identity or certification language', () => {
  const marketplace = read('src/app/marketplace/page.tsx')
  const detail = read('src/app/apis/[id]/[slug]/page.tsx')
  assert.match(marketplace, />Endpoint checked</)
  assert.match(detail, />Endpoint checked</)
  assert.match(detail, /label="Endpoint status"/)
  assert.doesNotMatch(detail, />Verified<|Verified listing|Not currently marked verified/)
})

test('Public Trust Layer remains present and unchanged in scope', () => {
  const providers = read('src/app/providers/page.tsx')
  const trust = read('src/components/PublicTrustPanel.tsx')
  assert.match(providers, /<PublicTrustPanel \/>/)
  for (const statement of ['PUBLIC REFERENCES', 'Public GitHub', 'Read the docs', 'support@mahshar.xyz', 'Arc Mainnet', 'Chain ID 5042']) {
    assert.ok(trust.includes(statement), statement)
  }
  assert.match(trust, /not operated by, endorsed by, or part of Circle/)
})
