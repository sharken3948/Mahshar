'use client'

const PREFIX = 'mahshar.purchase-access.v1'
export const PURCHASE_ACCESS_HEADER = 'x-mahshar-purchase-access'
const memory = new Map<string, string>()
const responseReads = new Map<string, Promise<PurchaseResponseResult>>()

function storageKey(wallet: string, apiId: string) {
  return `${PREFIX}:${wallet.trim().toLowerCase()}:${apiId.trim().toLowerCase()}`
}

function validToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 2048
}

export function rememberPurchaseAccess(wallet: string, apiId: string, token: unknown) {
  if (!validToken(token)) return false
  const key = storageKey(wallet, apiId)
  memory.set(key, token)
  try {
    window.localStorage.setItem(key, token)
    return window.localStorage.getItem(key) === token
  } catch {
    return false
  }
}

export function purchaseAccess(wallet: string, apiId: string) {
  const key = storageKey(wallet, apiId)
  try {
    const stored = window.localStorage.getItem(key)
    if (validToken(stored)) { memory.set(key, stored); return stored }
  } catch {}
  return memory.get(key) ?? null
}

function forgetPurchaseAccess(wallet: string, apiId: string) {
  const key = storageKey(wallet, apiId)
  memory.delete(key)
  try { window.localStorage.removeItem(key) } catch {}
}

export interface PurchaseResponsePayload {
  response_body: unknown
  purchase_access_token?: string
  error?: string
}

export interface PurchaseResponseResult {
  ok: boolean
  status: number
  data: PurchaseResponsePayload
}

export function readPurchasedResponse(input: {
  wallet: string
  apiId: string
  authorize: (path: string) => Promise<Response>
  fetcher?: typeof fetch
}): Promise<PurchaseResponseResult> {
  const wallet = input.wallet.trim().toLowerCase()
  const apiId = input.apiId.trim().toLowerCase()
  const key = storageKey(wallet, apiId)
  const existing = responseReads.get(key)
  if (existing) return existing

  const request = (async () => {
    const token = purchaseAccess(wallet, apiId)
    const path = `/api/calls/last-response?api_id=${encodeURIComponent(apiId)}&buyer_wallet=${encodeURIComponent(wallet)}`
    const response = token
      ? await (input.fetcher ?? fetch)(path, {
          cache: 'no-store',
          credentials: 'same-origin',
          headers: { [PURCHASE_ACCESS_HEADER]: token },
        })
      : await input.authorize(path)
    const data = await response.json().catch(() => ({})) as PurchaseResponsePayload
    if (response.ok) rememberPurchaseAccess(wallet, apiId, data.purchase_access_token)
    else if (token && (response.status === 401 || response.status === 403)) forgetPurchaseAccess(wallet, apiId)
    return { ok: response.ok, status: response.status, data }
  })()
  responseReads.set(key, request)
  const clear = () => { if (responseReads.get(key) === request) responseReads.delete(key) }
  void request.then(clear, clear)
  return request
}

/** Clears only process memory; persisted browser capabilities remain available. */
export function clearPurchaseAccessMemoryCache() {
  memory.clear()
  responseReads.clear()
}
