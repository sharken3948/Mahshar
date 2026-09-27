import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
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

test('listing mutations use exact operation authorization and server ownership checks', () => {
  const collection = readFileSync('src/app/api/apis/route.ts', 'utf8')
  const listing = readFileSync('src/app/api/apis/[id]/route.ts', 'utf8')
  const workspace = readFileSync('src/app/dashboard/dashboard-workspace.tsx', 'utf8')
  assert.match(collection, /export const POST = withOperationAuthorization/)
  assert.match(listing, /export const PATCH = withOperationAuthorization/)
  assert.match(listing, /export const DELETE = withOperationAuthorization/)
  assert.match(listing, /requireListingOwner/)
  assert.match(workspace, /authorizedFetch\(`\/api\/apis\//)
})

test('persistent wallet login architecture is removed', () => {
  for (const path of ['src/components/MarketplaceAuthProvider.tsx', 'src/lib/marketplace/client-session.ts',
    'src/lib/marketplace/auth.ts', 'src/app/api/marketplace/auth/[action]/route.ts']) assert.equal(existsSync(path), false)
  const source = readFileSync('src/lib/marketplace/server.ts', 'utf8')
  assert.match(source, /requireOperationAuthorization/)
  assert.doesNotMatch(source, /cookie|SESSION_SECONDS|MarketplaceAuth|authenticate\(/)
})

test('create remains signature-free while edit privately loads seller configuration with one-use authorization', () => {
  const onboarding = readFileSync('src/components/OnboardingForm.tsx', 'utf8')
  const workspace = readFileSync('src/app/dashboard/dashboard-workspace.tsx', 'utf8')
  const beginEdit = workspace.slice(workspace.indexOf('function beginEditApi'), workspace.indexOf('async function handleDeposit'))
  assert.match(beginEdit, /setShowEditModal\(true\)/)
  assert.match(beginEdit, /authorizedFetch\(`\/api\/apis\//)
  assert.doesNotMatch(beginEdit, /signTypedData|signMessage/)
  assert.doesNotMatch(onboarding.slice(onboarding.indexOf('export function OnboardingForm'), onboarding.indexOf('async function handleScore')), /marketplaceFetch\(/)
})
