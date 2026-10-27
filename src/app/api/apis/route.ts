import { listingPrice, workerListingInput, matchesWorkerListing } from '@/lib/free-api-worker/listing'
import { MAX_LISTING_BODY_BYTES } from '@/lib/marketplace/listing-body'
import { resourceAdmission } from '@/lib/resource-admission'
import { withWalletSession, marketplaceErrors, requireWalletSession } from '@/lib/marketplace/server'
import { assertWalletClaim, normalizedWallet } from '@/lib/marketplace/operation-authorization'
import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { PROVIDER_AUTH_TYPES, validateProviderCredential, isOAuth, oauthConfiguration } from '@/lib/marketplace/provider-auth-config';
import { approvedOAuthProfile } from '@/lib/marketplace/provider-oauth-profiles';
import { encryptKey } from '@/lib/crypto';
import { validateEndpointUrl } from '@/lib/url-validation';
import { isValidWalletAddress } from '@/lib/wallet-validation';
import { normalizeExpectedStatusCodes } from '@/lib/marketplace/listing-security';
import { PUBLIC_LISTING_COLUMNS, publicListing } from '@/lib/marketplace/public-listing';
import { listingContractMetadata } from '@/lib/marketplace/listing-contract-metadata';
import { SUPPORTED_LISTING_METHODS, validateListingRequestContract } from '@/lib/marketplace/request-contract';
import { enforceRateLimit } from '@/lib/rate-limit';
import { readBoundedJson, RequestBodyError } from '@/lib/request-body';

const MAX_LISTING_CREATE_BODY_BYTES = MAX_LISTING_BODY_BYTES;
const LISTING_CREATE_RATE_LIMIT = 10;
const LISTING_CREATE_RATE_WINDOW_SECONDS = 60;

export const runtime = 'nodejs';

export const GET = marketplaceErrors(async (request: NextRequest) => {
  const supabase = createServiceClient();
  const { searchParams } = new URL(request.url);

  const sellerClaim = searchParams.get('seller_wallet')
  const sellerWallet = sellerClaim !== null ? normalizedWallet(sellerClaim) : null
  if (sellerWallet) {
    const authorizedWallet = await requireWalletSession(request)
    assertWalletClaim(sellerWallet, authorizedWallet)
  }

  let query = supabase
    .from('api_listings')
    .select(`${PUBLIC_LISTING_COLUMNS}, endpoint_url, auth_param_name`)

  if (!sellerWallet) {
    query = query.eq('is_active', true)
  } else if (!isValidWalletAddress(sellerWallet)) {
    return NextResponse.json({ error: 'Invalid seller_wallet address' }, { status: 400 });
  }

  const category = searchParams.get('category')
  if (category && category !== 'All') {
    query = query.eq('category', category)
  }

  const q = searchParams.get('q')
  if (q) {
    query = query.ilike('name', `%${q}%`)
  }

  if (sellerWallet) {
    query = query.ilike('seller_wallet', sellerWallet)
  }

  const offset = Number(searchParams.get('offset') ?? 0)
  if (!Number.isInteger(offset) || offset < 0 || offset > 10000) return NextResponse.json({ error: 'invalid_offset' }, { status: 400 })
  const limit = searchParams.get('limit')
  if (limit) {
    const parsedLimit = parseInt(limit, 10)
    if (isFinite(parsedLimit) && parsedLimit > 0) query = query.limit(Math.min(parsedLimit, 100))
  }

  const parsedPublicLimit = parseInt(limit ?? '', 10)
  const publicLimit = Number.isFinite(parsedPublicLimit) && parsedPublicLimit > 0 ? Math.min(parsedPublicLimit, 100) : 1000
  if (!sellerWallet) query = query.range(offset, offset + publicLimit - 1)
  const load = async () => {
    const result = await query.order('created_at', { ascending: false })
    if (result.error) throw new Error('catalog_read_failed')
    return result
  }
  const { data, error } = await load().catch(() => ({ data: null, error: { message: 'Catalog temporarily unavailable' } }))
  if (error) return NextResponse.json({ error: 'Catalog temporarily unavailable' }, { status: 503, headers: { 'Retry-After': '5', 'Cache-Control': 'no-store' } });
  const rows = (data ?? []) as unknown as Record<string, unknown>[]
  const audited = rows.map(row => ({ row, contract: validateListingRequestContract(row as Parameters<typeof validateListingRequestContract>[0]) }))
  const apis = sellerWallet
    ? audited.map(({ row, contract }) => ({ ...publicListing(row), request_contract_error: contract.ok ? null : contract.error }))
    : audited.filter(({ contract }) => contract.ok).map(({ row }) => publicListing(row))
  return NextResponse.json({ apis }, { headers: { 'Cache-Control': 'no-store' } });
})

export const POST = withWalletSession(async (request: NextRequest, authenticatedWallet: string) => {
  const limited = await enforceRateLimit({
    request,
    scope: 'listing-create',
    limit: LISTING_CREATE_RATE_LIMIT,
    windowSeconds: LISTING_CREATE_RATE_WINDOW_SECONDS,
    wallet: authenticatedWallet,
    failClosed: true,
  });

  if (limited) return limited;

  let body: Record<string, unknown>;
  try {
    const parsed = await readBoundedJson<unknown>(request, MAX_LISTING_CREATE_BODY_BYTES);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    body = parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return NextResponse.json(
        { error: error.code === 'body_too_large' ? 'Request body too large' : 'Invalid JSON body' },
        { status: error.code === 'body_too_large' ? 413 : 400 }
      );
    }
    throw error;
  }

  const workerId = body.free_worker_candidate_id
  const workerInput = workerId !== undefined
    ? await workerListingInput(workerId, authenticatedWallet, listingPrice(body.price_per_call === 0 ? 'FREE' : 'PAID', body.price_per_call), body.owner_rights_confirmed) : null
  if (workerInput) {
    assertWalletClaim(body.seller_wallet, authenticatedWallet)
    body = workerInput
  }

  const { name, description, category, price_per_call, payment_model, seller_wallet, auth_type, auth_key, auth_param_name, endpoint_url, method, example_request, example_response } = body;

  assertWalletClaim(seller_wallet, authenticatedWallet);

  if (!name || !description || !category || !payment_model || !endpoint_url) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }
  if (
    typeof name !== 'string' ||
    typeof description !== 'string' ||
    typeof category !== 'string' ||
    typeof payment_model !== 'string' ||
    typeof endpoint_url !== 'string' ||
    (method !== undefined && typeof method !== 'string') ||
    typeof auth_type !== 'string' ||
    (auth_key !== undefined && auth_key !== null && typeof auth_key !== 'string') ||
    (auth_param_name !== undefined && auth_param_name !== null && typeof auth_param_name !== 'string') ||
    (example_request !== undefined && example_request !== null && typeof example_request !== 'string') ||
    (example_response !== undefined && example_response !== null && typeof example_response !== 'string') ||
    (body.body_required !== undefined && body.body_required !== null && typeof body.body_required !== 'boolean') ||
    (body.dynamic_path_supported !== undefined && typeof body.dynamic_path_supported !== 'boolean') ||
    (body.path_parameters !== undefined && body.path_parameters !== null && !Array.isArray(body.path_parameters)) ||
    (body.query_parameters !== undefined && body.query_parameters !== null && !Array.isArray(body.query_parameters))
  ) {
    return NextResponse.json({ error: 'Invalid listing fields' }, { status: 400 });
  }
  if (!['pay-per-call', 'credits', 'both'].includes(payment_model)) {
    return NextResponse.json({ error: 'Invalid payment model' }, { status: 400 });
  }

  const normalizedMethod = (method ?? 'GET').toUpperCase();
  if (!SUPPORTED_LISTING_METHODS.includes(normalizedMethod as typeof SUPPORTED_LISTING_METHODS[number])) {
    return NextResponse.json({ error: 'Method must be GET, POST, PUT, or DELETE' }, { status: 400 });
  }
  if (!(PROVIDER_AUTH_TYPES as readonly string[]).includes(auth_type)) {
    return NextResponse.json({ error: 'Invalid auth_type' }, { status: 400 });
  }
  if (!validateProviderCredential(auth_type, auth_key, auth_param_name as string | null)) {
    return NextResponse.json({ error: 'A credential is required for the selected authentication type' }, { status: 400 });
  }
  if (typeof price_per_call !== 'number' || !isFinite(price_per_call) || (price_per_call < 0 || price_per_call === 0 && !workerInput)) {
    return NextResponse.json({ error: 'price_per_call must be a positive number' }, { status: 400 });
  }

  const expectedResult = normalizeExpectedStatusCodes(body.expected_status_codes);
  if (!expectedResult.ok) return NextResponse.json({ error: expectedResult.error }, { status: 400 });
  const contractResult = listingContractMetadata(body, normalizedMethod);
  if (!contractResult.ok) return NextResponse.json({ error: contractResult.error }, { status: 400 });

  const requestContract = validateListingRequestContract({
    endpoint_url, method: normalizedMethod, auth_type, auth_param_name,
    example_request, body_required: body.body_required, request_schema: body.request_schema,
    dynamic_path_supported: body.dynamic_path_supported ?? false,
    path_parameters: Array.isArray(body.path_parameters) ? body.path_parameters : null,
    query_parameters: Array.isArray(body.query_parameters) ? body.query_parameters : null,
  });
  if (!requestContract.ok) {
    return NextResponse.json({ error: requestContract.error, field: requestContract.field }, { status: 400 });
  }

  const admission = await resourceAdmission('listing-create', authenticatedWallet)
  if (admission.response) return admission.response
  const urlValidation = await validateEndpointUrl(endpoint_url);
  if (!urlValidation.valid) {
    return NextResponse.json({ error: 'Invalid endpoint URL', reason: urlValidation.error }, { status: 400 });
  }

  if (isOAuth(auth_type)) {
    try {
      const config = oauthConfiguration(auth_key as string)
      const profile = approvedOAuthProfile(config.provider, endpoint_url, auth_type === 'oauth_pkce' ? 'authorization_code' : 'client_credentials')
      if (profile.client_auth !== 'none' && !config.client_secret) throw new Error()
    } catch { return NextResponse.json({ error: 'OAuth provider configuration is not approved' }, { status: 400 }) }
  }
  const encrypted_key = auth_type !== 'public' && auth_key ? encryptKey(auth_key) : null;
  const supabase = createServiceClient();

  if (workerInput) {
    const { data: existing, error } = await createServiceClient().from('api_listings').select('*').eq('free_worker_candidate_id', workerId).maybeSingle()
    if (error) return NextResponse.json({ error: 'Listing lookup failed' }, { status: 503 })
    if (existing) return matchesWorkerListing(existing, workerInput)
      ? NextResponse.json({ id: existing.id }, { status: 200 })
      : NextResponse.json({ error: 'Existing listing differs from selection; review it in Seller.' }, { status: 409 })
  }

  if (workerInput) {
    const { data: conflicts, error } = await supabase.from('api_listings').select('id').eq('endpoint_url', endpoint_url).ilike('seller_wallet', authenticatedWallet)
    if (error) return NextResponse.json({ error: 'Duplicate check unavailable' }, { status: 503 })
    if (conflicts?.length) return NextResponse.json({ error: 'This endpoint already has a Seller listing. Review the existing product.' }, { status: 409 })
  }

  const { data, error } = await supabase
    .from('api_listings')
    .insert({
      ...(workerInput ? { free_worker_candidate_id: workerInput.free_worker_candidate_id,
        owner_rights_confirmation: workerInput.owner_rights_confirmation } : {}),
      name,
      description,
      category,
      price_per_call,
      payment_model,
      seller_wallet: authenticatedWallet,
      auth_type,
      encrypted_key,
      auth_param_name: auth_param_name ?? null,
      endpoint_url,
      method: normalizedMethod,
      example_request,
      example_response,
      expected_status_codes: expectedResult.codes,
      ...contractResult.patch,
      is_active: false,
    })
    .select('id')
    .single();

  if (error && workerInput) {
    const { data: existing } = await supabase.from('api_listings').select('*').eq('free_worker_candidate_id', workerId).maybeSingle()
    if (existing && matchesWorkerListing(existing, workerInput)) return NextResponse.json({ id: existing.id })
  }
  if (error) return NextResponse.json({ error: 'Listing creation failed' }, { status: 500 });
  return NextResponse.json({ id: data.id }, { status: 201 });
})
