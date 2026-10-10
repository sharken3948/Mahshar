import { publicListing } from '@/lib/marketplace/public-listing'
import { validateListingRequestContract } from '@/lib/marketplace/request-contract'

export const SITE_ORIGIN = 'https://mahshar.xyz'
export const SEO_SLUG_FALLBACK = 'api'
export const SEO_NAME_MAX_LENGTH = 120
export const SEO_DESCRIPTION_MAX_LENGTH = 1000
export const SEO_CATEGORY_MAX_LENGTH = 80

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type PublicSeoListing = {
  id: string
  name: string
  description: string
  category: string
  pricePerCall: number
  paymentModel: 'pay-per-call'
  authType: 'public' | 'apikey' | 'bearer' | 'queryparam'
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  score: number | null
  verified: boolean
}

export function isValidListingId(value: string): boolean {
  return UUID_PATTERN.test(value)
}

export function slugifyListingName(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return slug || SEO_SLUG_FALLBACK
}

export function apiListingPath(listing: Pick<PublicSeoListing, 'id' | 'name'>): string {
  return `/apis/${encodeURIComponent(listing.id)}/${slugifyListingName(listing.name)}`
}

export function apiListingCanonicalUrl(listing: Pick<PublicSeoListing, 'id' | 'name'>): string {
  return `${SITE_ORIGIN}${apiListingPath(listing)}`
}

export function listingMetadataTitle(listing: Pick<PublicSeoListing, 'name'>): string {
  const suffix = /\bapi$/i.test(listing.name) ? '' : ' API'
  return `${listing.name}${suffix} — Pay per Call with USDC | Mahshar`
}

export function listingRouteDecision(
  listing: Pick<PublicSeoListing, 'id' | 'name'> | null,
  requestedSlug: string,
): { kind: 'not-found' } | { kind: 'render' } | { kind: 'redirect'; location: string } {
  if (!listing) return { kind: 'not-found' }
  const canonicalSlug = slugifyListingName(listing.name)
  return requestedSlug === canonicalSlug
    ? { kind: 'render' }
    : { kind: 'redirect', location: apiListingPath(listing) }
}

function isBoundedString(value: unknown, maximumLength: number, requireContent = false): value is string {
  return typeof value === 'string'
    && value.length <= maximumLength
    && (!requireContent || value.trim().length > 0)
}

/**
 * Applies the executable-listing contract before producing an SEO-safe DTO.
 * Validation-only endpoint and credential-location fields are deliberately
 * omitted from the returned object by first passing through publicListing().
 */
export function toPublicSeoListing(row: Record<string, unknown>): PublicSeoListing | null {
  if (row.is_active !== true) return null
  const validation = validateListingRequestContract(
    row as Parameters<typeof validateListingRequestContract>[0],
  )
  if (!validation.ok) return null

  const safe = publicListing(row)
  const authType = safe.auth_type
  if (
    typeof safe.id !== 'string' || !isValidListingId(safe.id) ||
    !isBoundedString(safe.name, SEO_NAME_MAX_LENGTH, true) ||
    !isBoundedString(safe.description, SEO_DESCRIPTION_MAX_LENGTH) ||
    !isBoundedString(safe.category, SEO_CATEGORY_MAX_LENGTH, true) ||
    typeof safe.price_per_call !== 'number' || !Number.isFinite(safe.price_per_call) || safe.price_per_call <= 0 ||
    safe.payment_model !== 'pay-per-call' ||
    !['public', 'apikey', 'bearer', 'queryparam'].includes(String(authType))
  ) return null

  return {
    id: safe.id,
    name: safe.name,
    description: safe.description,
    category: safe.category,
    pricePerCall: safe.price_per_call,
    paymentModel: 'pay-per-call',
    authType: authType as PublicSeoListing['authType'],
    method: validation.method,
    score: typeof safe.score === 'number' && Number.isFinite(safe.score) ? safe.score : null,
    verified: typeof safe.verified_at === 'string' && safe.verified_at.length > 0,
  }
}

export function listingMetadataDescription(listing: Pick<PublicSeoListing, 'name' | 'description'>): string {
  const normalized = listing.description.replace(/\s+/g, ' ').trim()
  const base = normalized || `${listing.name} is available through the Mahshar AI API marketplace.`
  const suffix = ' Pay per call with USDC via x402 on Arc Mainnet.'
  const maximumBaseLength = 160 - suffix.length
  const shortened = base.length > maximumBaseLength
    ? `${base.slice(0, Math.max(0, maximumBaseLength - 1)).trimEnd()}…`
    : base
  return `${shortened}${suffix}`
}
