import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

test('withdrawal retains its amount-specific signature and one-time nonce', () => {
  const client = readFileSync('src/app/dashboard/dashboard-workspace.tsx', 'utf8')
  const route = readFileSync('src/app/api/seller/withdraw/route.ts', 'utf8')
  assert.match(client, /buildWithdrawMessage/)
  assert.match(client, /signMessageAsync\(\{ message \}\)/)
  assert.match(client, /fetch\('\/api\/seller\/withdraw'/)
  assert.doesNotMatch(client, /requireWalletAuth/)
  assert.match(route, /Missing signature, timestamp, or nonce/)
  assert.match(route, /verifyMessage\(/)
  assert.match(route, /Nonce has already been used/)
})

test('listing mutations use the wallet session and server ownership checks', () => {
  const collection = readFileSync('src/app/api/apis/route.ts', 'utf8')
  const listing = readFileSync('src/app/api/apis/[id]/route.ts', 'utf8')
  const workspace = readFileSync('src/app/dashboard/dashboard-workspace.tsx', 'utf8')
  assert.match(collection, /export const POST = withWalletSession/)
  assert.match(listing, /export const PATCH = withWalletSession/)
  assert.match(listing, /export const DELETE = withWalletSession/)
  assert.match(listing, /requireListingOwner/)
  assert.match(workspace, /authorizedFetch\(`\/api\/apis\//)
})

test('persistent wallet login uses opaque HttpOnly database-backed sessions', () => {
  const source = readFileSync('src/lib/marketplace/server.ts', 'utf8')
  const route = readFileSync('src/app/api/auth/session/route.ts', 'utf8')
  const provider = readFileSync('src/components/MarketplaceSessionProvider.tsx', 'utf8')
  assert.match(source, /requireWalletSession/)
  assert.match(route, /httpOnly: true/)
  assert.match(route, /sameSite: 'lax'/)
  assert.match(route, /secure: process\.env\.NODE_ENV === 'production'/)
  assert.match(provider, /loginInFlight/)
})

test('listing creation and edits share session requests without operation signatures', () => {
  const onboarding = readFileSync('src/components/OnboardingForm.tsx', 'utf8')
  const workspace = readFileSync('src/app/dashboard/dashboard-workspace.tsx', 'utf8')
  const beginEdit = workspace.slice(workspace.indexOf('function beginEditApi'), workspace.indexOf('async function handleDeposit'))
  assert.match(beginEdit, /setShowEditModal\(true\)/)
  assert.match(beginEdit, /privateFetch\(wallet, `\/api\/apis\//)
  assert.match(beginEdit, /if \(!isCurrentWallet\(wallet\)\) return/)
  assert.doesNotMatch(beginEdit, /signTypedData|signMessage/)
  assert.match(onboarding, /useMarketplaceSession/)
  assert.match(onboarding, /marketplaceFetch\('\/api\/apis'/)
  assert.doesNotMatch(onboarding, /useSignTypedData|useSignMessage/)
})
