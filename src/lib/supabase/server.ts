import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

const _rawUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const _rawAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const _rawServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!_rawUrl) throw new Error('NEXT_PUBLIC_SUPABASE_URL environment variable is required');
if (!_rawAnonKey) throw new Error('NEXT_PUBLIC_SUPABASE_ANON_KEY environment variable is required');
if (!_rawServiceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY environment variable is required');

// Rebind as string constants so TypeScript sees them as non-nullable inside function bodies
const SUPABASE_URL = _rawUrl;
const SUPABASE_ANON_KEY = _rawAnonKey;
const SUPABASE_SERVICE_KEY = _rawServiceKey;

export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient(
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          );
        },
      },
    }
  );
}

export function createServiceClient() {
  return createServerClient(
    SUPABASE_URL,
    SUPABASE_SERVICE_KEY,
    {
      cookies: { getAll: () => [], setAll: () => {} },
    }
  );
}
