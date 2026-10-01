import 'server-only'

import { isValidListingId, toPublicSeoListing, type PublicSeoListing } from './listing'

// Nested request fields and upstream configuration are read only to validate
// the existing executable request contract. None can enter PublicSeoListing.
export const SEO_CATALOG_COLUMNS = [
  'id', 'name', 'description', 'category', 'price_per_call', 'payment_model',
  'score', 'is_active', 'auth_type', 'method', 'verified_at',
  'endpoint_url', 'auth_param_name', 'example_request', 'body_required',
  'dynamic_path_supported', 'path_parameters', 'query_parameters',
].join(', ')

async function serviceClient() {
  // Keep server configuration failures inside SEO routes instead of making the
  // public catalog module capable of breaking unrelated application imports.
  const { createServiceClient } = await import('@/lib/supabase/server')
  return createServiceClient()
}

function validatedListings(rows: unknown[] | null): PublicSeoListing[] {
  return (rows ?? []).flatMap(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return []
    try {
      const listing = toPublicSeoListing(row as Record<string, unknown>)
      return listing ? [listing] : []
    } catch {
      console.error('[seo-catalog] excluded invalid listing')
      return []
    }
  })
}

export async function getPublicSeoListings(): Promise<PublicSeoListing[]> {
  try {
    const supabase = await serviceClient()
    const { data, error } = await supabase
      .from('api_listings')
      .select(SEO_CATALOG_COLUMNS)
      .eq('is_active', true)
      .order('created_at', { ascending: false })

    if (error) {
      console.error('[seo-catalog] listing read failed')
      return []
    }
    return validatedListings(data as unknown[] | null)
  } catch {
    console.error('[seo-catalog] listing read unavailable')
    return []
  }
}

export async function getPublicSeoListing(id: string): Promise<PublicSeoListing | null> {
  if (!isValidListingId(id)) return null
  try {
    const supabase = await serviceClient()
    const { data, error } = await supabase
      .from('api_listings')
      .select(SEO_CATALOG_COLUMNS)
      .eq('id', id)
      .eq('is_active', true)
      .maybeSingle()

    if (error) {
      console.error('[seo-catalog] listing detail read failed')
      return null
    }
    return validatedListings(data ? [data] : [])[0] ?? null
  } catch {
    console.error('[seo-catalog] listing detail unavailable')
    return null
  }
}
