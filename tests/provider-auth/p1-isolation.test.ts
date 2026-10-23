import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { NextRequest } from 'next/server'
import { existsSync, readFileSync } from 'node:fs'
import { reset, sessionHeaders, state, alice } from '../marketplace/fixtures'
import { resetBoundary } from './register.mjs'
import { POST as create } from '../../src/app/api/apis/route'
import { PATCH as edit } from '../../src/app/api/apis/[id]/route'
import { PROVIDER_AUTH_TYPES, validateProviderCredential } from '../../src/lib/marketplace/provider-auth-config'

beforeEach(() => { reset(); resetBoundary() })
test('P1 exposes exactly seven static auth types and excludes P2 runtime modules', () => {
  assert.deepEqual(PROVIDER_AUTH_TYPES, ['public', 'apikey', 'bearer', 'queryparam', 'basic', 'headers', 'authorization'])
  for (const path of ['src/app/api/provider-oauth/[id]/route.ts', 'src/app/api/provider-oauth/[id]/callback/route.ts',
    'src/app/provider-connections/[id]/page.tsx', 'src/components/ProviderOAuthControls.tsx', 'src/lib/marketplace/provider-oauth.ts',
    'src/lib/marketplace/provider-oauth-profiles.ts', 'src/lib/marketplace/provider-oauth-preflight.ts']) assert.equal(existsSync(path), false, path)
  for (const path of ['src/components/OnboardingForm.tsx', 'src/components/EditListingForm.tsx',
    'src/app/api/proxy/route.ts', 'src/app/api/proxy/[api_id]/route.ts', 'src/lib/marketplace/provider-auth.ts', 'openapi.yaml']) {
    assert.doesNotMatch(readFileSync(path, 'utf8'), /oauth_pkce|oauth_client_credentials|provider-oauth|provider-connections/)
  }
})

test('Create and Edit reject P2 auth types even if operator OAuth configuration is accidentally present', async () => {
  process.env.PROVIDER_OAUTH_PROFILES = '[{"id":"accidental-profile"}]'
  try {
    for (const auth_type of ['oauth_pkce', 'oauth_client_credentials']) {
      assert.equal(validateProviderCredential(auth_type, '{}'), false)
      const response = await create(new NextRequest('https://mahshar.xyz/api/apis', {
        method: 'POST', headers: sessionHeaders(), body: JSON.stringify({ name: 'P2 rejected', description: 'Synthetic', category: 'Data',
          price_per_call: 0.01, payment_model: 'pay-per-call', endpoint_url: 'https://provider.example/data', method: 'GET', auth_type, auth_key: '{}' }),
      }))
      assert.equal(response.status, 400)
      assert.equal(state.tables.api_listings.length, 0)
      state.tables.api_listings.push({ id: 'p1-listing', name: 'P1', seller_wallet: alice.address.toLowerCase(), auth_type: 'public' })
      const patch = await edit(new NextRequest('https://mahshar.xyz/api/apis/p1-listing', {
        method: 'PATCH', headers: sessionHeaders(), body: JSON.stringify({ auth_type }),
      }), { params: Promise.resolve({ id: 'p1-listing' }) })
      assert.equal(patch.status, 400)
      assert.equal(state.tables.api_listings[0].auth_type, 'public')
      state.tables.api_listings = []
    }
  } finally { delete process.env.PROVIDER_OAUTH_PROFILES }
})
