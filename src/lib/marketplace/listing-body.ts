/** One UTF-8 request-body ceiling for Seller Create, Edit and analysis. */
export const MAX_LISTING_BODY_BYTES = 64 * 1024
export const LISTING_BODY_LIMIT_MESSAGE = 'Listing request exceeds the 64 KiB limit. Reduce examples or metadata and try again. Your draft has been kept.'

export function serializeListingBody(value: unknown): string {
  const body = JSON.stringify(value)
  if (typeof body !== 'string') throw new Error('Invalid listing request')
  if (new TextEncoder().encode(body).byteLength > MAX_LISTING_BODY_BYTES) throw new Error(LISTING_BODY_LIMIT_MESSAGE)
  return body
}

export function listingResponseError(status: number, message?: string): string | undefined {
  return status === 413 ? LISTING_BODY_LIMIT_MESSAGE : message
}
