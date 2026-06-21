import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { encryptKey } from '@/lib/crypto';
import { validateEndpointUrl } from '@/lib/url-validation';
import { isValidWalletAddress } from '@/lib/wallet-validation';
import type { AuthType, PaymentModel } from '@/types';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const supabase = createServiceClient();
  const { searchParams } = new URL(request.url);

  const sellerWallet = searchParams.get('seller_wallet')

  let query = supabase
    .from('api_listings')
    .select('id, name, description, category, price_per_call, payment_model, score, uptime, is_active, seller_wallet, auth_type, created_at, verified_at, endpoint_url, method, example_request')

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
  return NextResponse.json({ apis: data });
}

export async function POST(request: NextRequest) {
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
  };

  const { name, description, category, price_per_call, payment_model, seller_wallet, auth_type, auth_key, auth_param_name, endpoint_url, method, example_request, example_response } = body;

  if (!name || !description || !category || !payment_model || !seller_wallet || !endpoint_url) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }
  if (typeof price_per_call !== 'number' || !isFinite(price_per_call) || price_per_call <= 0) {
    return NextResponse.json({ error: 'price_per_call must be a positive number' }, { status: 400 });
  }

  const urlValidation = await validateEndpointUrl(endpoint_url);
  if (!urlValidation.valid) {
    return NextResponse.json({ error: 'Invalid endpoint URL', reason: urlValidation.error }, { status: 400 });
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
      seller_wallet: seller_wallet.toLowerCase(),
      auth_type,
      encrypted_key,
      auth_param_name: auth_param_name ?? null,
      endpoint_url,
      method: method ?? 'GET',
      example_request,
      example_response,
      is_active: false,
    })
    .select('id')
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ id: data.id }, { status: 201 });
}
