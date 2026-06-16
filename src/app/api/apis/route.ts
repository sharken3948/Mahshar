import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { encryptKey } from '@/lib/crypto';
import type { AuthType, PaymentModel } from '@/types';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const supabase = createServiceClient();
  const { searchParams } = new URL(request.url);
  const category = searchParams.get('category');
  const search = searchParams.get('q');

  let query = supabase
    .from('api_listings')
    .select('id, name, description, category, price_per_call, payment_model, seller_wallet, auth_type, score, uptime, created_at, is_active')
    .eq('is_active', true)
    .order('score', { ascending: false });

  if (category) query = query.eq('category', category);
  if (search) query = query.ilike('name', `%${search}%`);

  const { data, error } = await query;
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
    endpoint_url: string;
    example_request?: string;
    example_response?: string;
  };

  const { name, description, category, price_per_call, payment_model, seller_wallet, auth_type, auth_key, endpoint_url, example_request, example_response } = body;

  if (!name || !description || !category || !price_per_call || !payment_model || !seller_wallet || !endpoint_url) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
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
      seller_wallet,
      auth_type,
      encrypted_key,
      endpoint_url,
      example_request,
      example_response,
      is_active: true,
    })
    .select('id')
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ id: data.id }, { status: 201 });
}
