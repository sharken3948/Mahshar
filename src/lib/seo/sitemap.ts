import type { MetadataRoute } from 'next'
import { apiListingCanonicalUrl, SITE_ORIGIN, type PublicSeoListing } from './listing'

export const STATIC_PUBLIC_PATHS = ['/', '/marketplace', '/about', '/providers', '/agents', '/docs', '/support'] as const

export function buildSitemap(listings: PublicSeoListing[]): MetadataRoute.Sitemap {
  const staticEntries: MetadataRoute.Sitemap = STATIC_PUBLIC_PATHS.map((path, index) => ({
    url: `${SITE_ORIGIN}${path}`,
    changeFrequency: index === 0 ? 'weekly' : 'monthly',
    priority: index === 0 ? 1 : path === '/marketplace' ? 0.9 : 0.7,
  }))
  const listingEntries: MetadataRoute.Sitemap = listings.map(listing => ({
    url: apiListingCanonicalUrl(listing),
    changeFrequency: 'weekly',
    priority: 0.8,
  }))
  return [...staticEntries, ...listingEntries]
}

export async function buildFailureTolerantSitemap(
  readListings: () => Promise<PublicSeoListing[]>,
): Promise<MetadataRoute.Sitemap> {
  try {
    return buildSitemap(await readListings())
  } catch {
    return buildSitemap([])
  }
}
