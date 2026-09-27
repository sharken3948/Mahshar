import 'server-only'
import { createHmac, timingSafeEqual } from 'node:crypto'

export const PURCHASE_ACCESS_HEADER = 'x-mahshar-purchase-access'

export interface PurchaseAccessClaims {
  version: 1
  purchaseId: string
  apiId: string
  buyerWallet: string
}

function signingKey() {
  const value = process.env.ENCRYPTION_KEY
  if (!value || !/^[\da-f]{64}$/i.test(value)) throw new Error('ENCRYPTION_KEY is unavailable')
  return createHmac('sha256', Buffer.from(value, 'hex')).update('mahshar-purchase-access-v1').digest()
}

function signature(payload: string) {
  return createHmac('sha256', signingKey()).update(payload).digest()
}

function boundedId(value: unknown) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && /^[\w-]+$/.test(value)
}

function wallet(value: unknown) {
  if (typeof value !== 'string' || !/^0x[\da-f]{40}$/i.test(value) || /^0x0{40}$/i.test(value)) {
    throw new Error('Invalid purchase access wallet')
  }
  return value.toLowerCase()
}

export function issuePurchaseAccess(input: { purchaseId: string; apiId: string; buyerWallet: string }) {
  if (!boundedId(input.purchaseId) || !boundedId(input.apiId)) throw new Error('Invalid purchase access scope')
  const claims: PurchaseAccessClaims = {
    version: 1,
    purchaseId: input.purchaseId,
    apiId: input.apiId,
    buyerWallet: wallet(input.buyerWallet),
  }
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${payload}.${signature(payload).toString('base64url')}`
}

export function verifyPurchaseAccess(value: string | null): PurchaseAccessClaims | null {
  if (!value || value.length > 2048) return null
  const parts = value.split('.')
  if (parts.length !== 2) return null
  let provided: Buffer
  try { provided = Buffer.from(parts[1], 'base64url') } catch { return null }
  const expected = signature(parts[0])
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null
  try {
    const claims = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as Partial<PurchaseAccessClaims>
    if (claims.version !== 1 || !boundedId(claims.purchaseId) || !boundedId(claims.apiId)) return null
    return {
      version: 1,
      purchaseId: claims.purchaseId as string,
      apiId: claims.apiId as string,
      buyerWallet: wallet(claims.buyerWallet),
    }
  } catch {
    return null
  }
}
