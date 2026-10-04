import { withWalletSession, marketplaceErrors, requireWalletSession } from '@/lib/marketplace/server'
import { assertWalletClaim, normalizedWallet } from '@/lib/marketplace/operation-authorization'
import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { encryptKey } from '@/lib/crypto';
import { validateEndpointUrl } from '@/lib/url-validation';
import { isValidWalletAddress } from '@/lib/wallet-validation';
import { normalizeExpectedStatusCodes } from '@/lib/marketplace/listing-security';
import type { AuthType, PaymentModel } from '@/types';
import { PUBLIC_LISTING_COLUMNS, publicListing } from '@/lib/marketplace/public-listing';
import { listingContractMetadata } from '@/lib/marketplace/listing-contract-metadata';
import { SUPPORTED_LISTING_METHODS, validateListingRequestContract } from '@/lib/marketplace/request-contract';

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

  const limit = searchParams.get('limit')
  if (limit) {
    const parsedLimit = parseInt(limit, 10)
    if (isFinite(parsedLimit) && parsedLimit > 0) query = query.limit(Math.min(parsedLimit, 100))
  }

  const { data, error } = await query.order('created_at', { ascending: false })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const rows = (data ?? []) as unknown as Record<string, unknown>[]
  const audited = rows.map(row => ({ row, contract: validateListingRequestContract(row as Parameters<typeof validateListingRequestContract>[0]) }))
  const apis = sellerWallet
    ? audited.map(({ row, contract }) => ({ ...publicListing(row), request_contract_error: contract.ok ? null : contract.error }))
    : audited.filter(({ contract }) => contract.ok).map(({ row }) => publicListing(row))
  return NextResponse.json({ apis }, sellerWallet ? { headers: { 'Cache-Control': 'no-store' } } : undefined);
})

export const POST = withWalletSession(async (request: NextRequest, authenticatedWallet: string) => {
  const supabase = createServiceClient();

  const body = await request.json() as {
    name: string;
    description: string;
    category: string;
    price_per_call: number;
    payment_model: PaymentModel;
    seller_wallet: string;
    auth_type: AuthType;
    auth_key?: string;
    auth_param_name?: string;
    endpoint_url: string;
    method?: string;
    example_request?: string;
    example_response?: string;
    expected_status_codes?: number[];
    request_schema?: Record<string, unknown> | null;
    response_schema?: Record<string, unknown> | null;
    body_required?: boolean | null;
    dynamic_path_supported?: boolean;
    path_parameters?: unknown[] | null;
    query_parameters?: unknown[] | null;
  };

  const { name, description, category, price_per_call, payment_model, seller_wallet, auth_type, auth_key, auth_param_name, endpoint_url, method, example_request, example_response } = body;
  const normalizedMethod = (method ?? 'GET').toUpperCase();
  const expectedResult = normalizeExpectedStatusCodes(body.expected_status_codes);
  if (!expectedResult.ok) return NextResponse.json({ error: expectedResult.error }, { status: 400 });
  const contractResult = listingContractMetadata(body as unknown as Record<string, unknown>, normalizedMethod);
  if (!contractResult.ok) return NextResponse.json({ error: contractResult.error }, { status: 400 });

  assertWalletClaim(seller_wallet, authenticatedWallet);

  if (!name || !description || !category || !payment_model || !endpoint_url) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }
  if (!SUPPORTED_LISTING_METHODS.includes(normalizedMethod as typeof SUPPORTED_LISTING_METHODS[number])) {
    return NextResponse.json({ error: 'Method must be GET, POST, PUT, or DELETE' }, { status: 400 });
  }
  if (!['public', 'apikey', 'bearer', 'queryparam'].includes(auth_type)) {
    return NextResponse.json({ error: 'Invalid auth_type' }, { status: 400 });
  }
  if (auth_type !== 'public' && !auth_key?.trim()) {
    return NextResponse.json({ error: 'A credential is required for the selected authentication type' }, { status: 400 });
  }
  if (typeof price_per_call !== 'number' || !isFinite(price_per_call) || price_per_call <= 0) {
    return NextResponse.json({ error: 'price_per_call must be a positive number' }, { status: 400 });
  }

  const urlValidation = await validateEndpointUrl(endpoint_url);
  if (!urlValidation.valid) {
    return NextResponse.json({ error: 'Invalid endpoint URL', reason: urlValidation.error }, { status: 400 });
  }

  const requestContract = validateListingRequestContract({
    endpoint_url, method: normalizedMethod, auth_type, auth_param_name,
    example_request, body_required: body.body_required, request_schema: body.request_schema,
    dynamic_path_supported: body.dynamic_path_supported ?? false,
    path_parameters: body.path_parameters ?? null,
    query_parameters: body.query_parameters ?? null,
  });
  if (!requestContract.ok) {
    return NextResponse.json({ error: requestContract.error, field: requestContract.field }, { status: 400 });
  }

  const encrypted_key = auth_key ? encryptKey(auth_key) : null;

  const { data, error } = await supabase
    .from('api_listings')
    .insert({
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

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ id: data.id }, { status: 201 });
})
