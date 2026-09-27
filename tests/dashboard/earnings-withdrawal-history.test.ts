import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

test('withdrawal history reuses the owner-authorized earnings read and exposes only display fields', () => {
  const route = readFileSync('src/app/api/seller/earnings/route.ts', 'utf8')
  const page = readFileSync('src/app/dashboard/earnings/page.tsx', 'utf8')

  assert.match(route, /export const GET = withOperationAuthorization/)
  assert.match(route, /assertWalletClaim\(searchParams\.get\('seller_wallet'\), sellerWallet\)/)
  assert.match(route, /\.select\('id, amount_usdc, net_amount_usdc, gas_cost_usdc, status, mint_tx_hash, created_at, minted_at'\)/)
  assert.match(route, /\.ilike\('seller_wallet', sellerWallet\)/)
  assert.match(route, /\.order\('created_at', \{ ascending: false \}\)/)
  assert.doesNotMatch(route, /\.select\([^\n]*(?:burn_intent|attestation|attestation_signature|network_id|seller_wallet)[^\n]*\)/)

  assert.match(page, /authorizedFetch\(`\/api\/seller\/earnings\?seller_wallet=/)
  assert.match(page, /RECENT_WITHDRAWAL_LIMIT = 6/)
  for (const label of ['Withdrawal History', 'Requested', 'Gas', 'Received', 'Completed', 'Pending', 'Failed', 'View on Explorer', 'No withdrawals yet']) {
    assert.ok(page.includes(label), label)
  }
})

test('withdrawal history resets on wallet changes and does not authorize during render', () => {
  const page = readFileSync('src/app/dashboard/earnings/page.tsx', 'utf8')
  assert.match(page, /useEffect\(\(\) => \{[\s\S]*setWithdrawals\(null\)[\s\S]*\}, \[address\]\)/)
  assert.match(page, /currentAddress\.current\?\.toLowerCase\(\) !== requestedWallet/)
  assert.match(page, /withdrawalHistoryWallet === address\?\.toLowerCase\(\) \? withdrawals : null/)
  assert.match(page, /onClick=\{onLoad\}/)
  assert.doesNotMatch(page, /useEffect\(\(\) => \{\s*void loadWithdrawalHistory/)
})
