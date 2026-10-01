import type { MetadataRoute } from 'next'
import { getPublicSeoListings } from '@/lib/seo/public-catalog'
import { buildFailureTolerantSitemap } from '@/lib/seo/sitemap'

export const revalidate = 3600

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  // The reader fails closed to an empty dynamic catalog, so these static public
  // URLs remain available even when the listing database is unavailable.
  return buildFailureTolerantSitemap(getPublicSeoListings)
}
