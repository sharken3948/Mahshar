import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { validateEndpointUrl } from '@/lib/url-validation'
import { encryptKey } from '@/lib/crypto'
import { withWalletSession, requireListingOwner, requireOperationAuthorizationForPayload } from '@/lib/marketplace/server'
import { assertWalletClaim, OPERATION_AUTH_HEADER } from '@/lib/marketplace/operation-authorization'
import { credentialProxyAllowed, SENSITIVE_CONFIGURATION, matchListingConfiguration, normalizeExpectedStatusCodes, expectedCodesEqual } from '@/lib/marketplace/listing-security'
import { listingContractMetadata } from '@/lib/marketplace/listing-contract-metadata'
import { validateListingRequestContract } from '@/lib/marketplace/request-contract'

export const runtime = 'nodejs'
type Context = { params: Promise<{ id: string }> }

function sameConfiguration(left: unknown, right: unknown) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
}

function sensitivePatchChanged(body: Record<string, unknown>, patch: Record<string, unknown>, listing: Record<string, unknown>) {
  if (body.auth_key !== undefined) return true
  return SENSITIVE_CONFIGURATION.some(key => key !== 'encrypted_key' && patch[key] !== undefined
    && !sameConfiguration(patch[key], listing[key]))
}

export const GET = withWalletSession(async (_request: NextRequest, wallet: string, { params }: Context) => {
  const { id } = await params
  const listing = await requireListingOwner(createServiceClient(), id, wallet)
  const requestContract = validateListingRequestContract(listing)
  return NextResponse.json({
    api: {
      id: listing.id,
      name: listing.name,
      description: listing.description,
      category: listing.category,
      price_per_call: listing.price_per_call,
      payment_model: listing.payment_model,
      seller_wallet: listing.seller_wallet,
      auth_type: listing.auth_type,
      auth_param_name: listing.auth_param_name,
      endpoint_url: listing.endpoint_url,
      method: listing.method,
      example_request: listing.example_request,
      example_response: listing.example_response,
      expected_status_codes: listing.expected_status_codes,
      request_schema: listing.request_schema,
      response_schema: listing.response_schema,
      body_required: listing.body_required,
      dynamic_path_supported: listing.dynamic_path_supported,
      path_parameters: listing.path_parameters,
      query_parameters: listing.query_parameters,
      score: listing.score,
      uptime: listing.uptime,
      created_at: listing.created_at,
      is_active: listing.is_active,
      verified_at: listing.verified_at,
      credential_configured: Boolean(listing.encrypted_key),
      request_contract_error: requestContract.ok ? null : requestContract.error,
    },
  })
})

export const PATCH = withWalletSession(async (request: NextRequest, wallet: string, { params }: Context) => {
  const { id } = await params
  const db = createServiceClient()
  const listing = await requireListingOwner(db, id, wallet)
  const body = await request.json() as Record<string, unknown>
  assertWalletClaim(body.seller_wallet, wallet)
  const patch: Record<string, unknown> = {}
  for (const key of ['name', 'category', 'description', 'endpoint_url', 'auth_type', 'auth_param_name', 'method', 'example_request', 'example_response']) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== 'string') return NextResponse.json({ error: `Invalid ${key}` }, { status: 400 })
      patch[key] = body[key]
    }
  }
  if (patch.endpoint_url !== undefined) {
    const validation = await validateEndpointUrl(patch.endpoint_url as string)
    if (!validation.valid) return NextResponse.json({ error: 'Invalid endpoint URL' }, { status: 400 })
  }
  if (patch.auth_type !== undefined && !['public', 'apikey', 'bearer', 'queryparam'].includes(patch.auth_type as string)) {
    return NextResponse.json({ error: 'Invalid auth_type' }, { status: 400 })
  }
  if (patch.method !== undefined && !['GET', 'POST', 'PUT', 'DELETE'].includes(patch.method as string)) {
    return NextResponse.json({ error: 'Invalid method' }, { status: 400 })
  }
  if (body.auth_key !== undefined) {
    if (typeof body.auth_key !== 'string') return NextResponse.json({ error: 'Invalid auth_key' }, { status: 400 })
    patch.encrypted_key = body.auth_key ? encryptKey(body.auth_key) : null
  }
  if (body.price_per_call !== undefined) {
    if (typeof body.price_per_call !== 'number' || !Number.isFinite(body.price_per_call) || body.price_per_call <= 0) {
      return NextResponse.json({ error: 'price_per_call must be a positive number' }, { status: 400 })
    }
    patch.price_per_call = body.price_per_call
  }
  if (body.is_active !== undefined) {
    if (typeof body.is_active !== 'boolean') return NextResponse.json({ error: 'Invalid is_active' }, { status: 400 })
    patch.is_active = body.is_active
  }
  if (body.expected_status_codes !== undefined) {
    const result = normalizeExpectedStatusCodes(body.expected_status_codes)
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })
    patch.expected_status_codes = result.codes
  }
  const contractResult = listingContractMetadata(body, String(patch.method ?? listing.method ?? 'GET').toUpperCase())
  if (!contractResult.ok) return NextResponse.json({ error: contractResult.error }, { status: 400 })
  Object.assign(patch, contractResult.patch)
  const updated = { ...listing, ...patch }
  const contractFields = ['endpoint_url', 'method', 'auth_type', 'auth_param_name', 'example_request', 'body_required', 'request_schema',
    'dynamic_path_supported', 'path_parameters', 'query_parameters']
  const contractChanged = contractFields.some(key => patch[key] !== undefined && !sameConfiguration(patch[key], listing[key]))
  if (contractChanged || patch.is_active === true) {
    const requestContract = validateListingRequestContract(updated)
    if (!requestContract.ok) {
      return NextResponse.json({ error: requestContract.error, field: requestContract.field }, { status: 400 })
    }
  }
  if ((updated.auth_type === 'apikey' || updated.auth_type === 'bearer' || updated.auth_type === 'queryparam')
    && !updated.encrypted_key) {
    return NextResponse.json({ error: 'A credential is required for the selected authentication type' }, { status: 400 })
  }
  if (sensitivePatchChanged(body, patch, listing) || request.headers.has(OPERATION_AUTH_HEADER)) {
    const operationWallet = await requireOperationAuthorizationForPayload(request, body)
    assertWalletClaim(operationWallet, wallet)
  }
  if (SENSITIVE_CONFIGURATION.some(key => patch[key] !== undefined && !sameConfiguration(patch[key], listing[key])) ||
    (patch.example_request !== undefined && !sameConfiguration(patch.example_request, listing.example_request))) {
    patch.verified_at = null
    patch.is_active = false
  }
  // Changing the declared expected-code set invalidates prior verification —
  // an existing verified_at may have passed only because a code was previously declared expected.
  if (patch.expected_status_codes !== undefined && !expectedCodesEqual(patch.expected_status_codes as number[] | null, listing.expected_status_codes as number[] | null)) {
    patch.verified_at = null
    patch.is_active = false
  }
  if (patch.is_active === true && !credentialProxyAllowed(updated)) {
    return NextResponse.json({ error: 'Verify the endpoint before activation' }, { status: 409 })
  }
  const { data, error } = await matchListingConfiguration(db.from('api_listings').update(patch).eq('id', id).ilike('seller_wallet', wallet), listing).select('id')
  if (error) return NextResponse.json({ error: 'Listing update failed' }, { status: 500 })
  if (!data?.length) return NextResponse.json({ error: 'Listing changed; reload before editing' }, { status: 409 })
  return NextResponse.json({ success: true })
})

export const DELETE = withWalletSession(async (request: NextRequest, wallet: string, { params }: Context) => {
  const { id } = await params
  const db = createServiceClient()
  await requireListingOwner(db, id, wallet)
  const body = await request.json().catch(() => ({}))
  assertWalletClaim(body.seller_wallet, wallet)
  const { error } = await db.from('api_listings').delete().eq('id', id).ilike('seller_wallet', wallet)
  if (error) return NextResponse.json({ error: 'Listing deletion failed' }, { status: 500 })
  return NextResponse.json({ success: true })
})
