export type PublicAgentListing = {
  id: string
  name: string
  price_per_call_usdc: number
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  proxy_url: string
  proxy_style: 'path' | 'envelope'
  request: {
    outer_method: string
    body: { supported: boolean; required: boolean | null; example: unknown }
    dynamic_path: { supported: boolean; transport: string | null }
    query_parameters: Array<{ name?: string; enum?: string[] }>
  }
}

export type AgentSigner = {
  address: `0x${string}`
  signTypedData(input: {
    domain: { name: string; version: string; chainId: number; verifyingContract: `0x${string}` }
    types: Record<string, Array<{ name: string; type: string }>>
    primaryType: 'TransferWithAuthorization'
    message: Record<string, string | bigint>
  }): Promise<`0x${string}`>
}

export interface CapabilityStore {
  get(wallet: string, apiId: string): Promise<string | null>
  set(wallet: string, apiId: string, capability: string): Promise<void>
}

type PaymentRequirement = {
  scheme: string
  network: string
  asset: string
  amount: string
  payTo: string
  maxTimeoutSeconds: number
  extra: { name: string; version: string; verifyingContract: string }
}

type PaymentRequired = {
  x402Version: number
  resource: Record<string, unknown>
  accepts: PaymentRequirement[]
}

export class MemoryCapabilityStore implements CapabilityStore {
  private values = new Map<string, string>()
  private key(wallet: string, apiId: string) { return `${wallet.toLowerCase()}:${apiId}` }
  async get(wallet: string, apiId: string) { return this.values.get(this.key(wallet, apiId)) ?? null }
  async set(wallet: string, apiId: string, capability: string) { this.values.set(this.key(wallet, apiId), capability) }
}

export class MahsharPublicAgent {
  private paymentRecipient: string | null = null
  private paymentDomain: { name: string; version: string; verifyingContract: string } | null = null

  constructor(
    readonly baseUrl: string,
    readonly signer: AgentSigner,
    readonly capabilities: CapabilityStore,
    readonly fetcher: typeof fetch = fetch,
    readonly maxListingPriceUsdc = 0.001,
  ) {
    const url = new URL(baseUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/') {
      throw new Error('MAHSHAR_BASE_URL must be an origin URL')
    }
  }

  private url(pathOrUrl: string) { return new URL(pathOrUrl, this.baseUrl).toString() }

  async discover(): Promise<{ openapi: string; catalog: Record<string, unknown>; listings: PublicAgentListing[] }> {
    const response = await this.fetcher(this.url('/api/agent/discover'))
    if (!response.ok) throw new Error(`Discovery failed (${response.status})`)
    const catalog = await response.json() as Record<string, unknown>
    const openapiUrl = catalog.openapi_url
    if (typeof openapiUrl !== 'string') throw new Error('Discovery omitted openapi_url')
    const openapiResponse = await this.fetcher(this.url(openapiUrl))
    if (!openapiResponse.ok) throw new Error(`OpenAPI fetch failed (${openapiResponse.status})`)
    const openapi = await openapiResponse.text()
    if (!/^openapi:\s*3\./m.test(openapi)) throw new Error('Invalid OpenAPI document')
    const listings = catalog.apis
    if (!Array.isArray(listings)) throw new Error('Discovery omitted apis[]')
    const paymentRecipient = catalog.payment_recipient
    const paymentDomain = catalog.payment_domain as Record<string, unknown> | undefined
    if (typeof paymentRecipient !== 'string' || !/^0x[\da-f]{40}$/i.test(paymentRecipient)) {
      throw new Error('Discovery omitted a valid payment_recipient')
    }
    if (!paymentDomain || typeof paymentDomain.name !== 'string' || typeof paymentDomain.version !== 'string' ||
      typeof paymentDomain.verifyingContract !== 'string' || !/^0x[\da-f]{40}$/i.test(paymentDomain.verifyingContract)) {
      throw new Error('Discovery omitted a valid payment_domain')
    }
    this.paymentRecipient = paymentRecipient
    this.paymentDomain = { name: paymentDomain.name, version: paymentDomain.version, verifyingContract: paymentDomain.verifyingContract }
    return { openapi, catalog, listings: listings as PublicAgentListing[] }
  }

  select(listings: PublicAgentListing[], style: 'path' | 'envelope') {
    const listing = listings.find(item => item.proxy_style === style && item.price_per_call_usdc <= this.maxListingPriceUsdc)
    if (!listing) throw new Error(`No ${style} listing at or below ${this.maxListingPriceUsdc} USDC`)
    return listing
  }

  selectControlledFailure(listings: PublicAgentListing[]) {
    const listing = listings.find(item => item.proxy_style === 'envelope' && item.request.dynamic_path.supported &&
      item.price_per_call_usdc <= this.maxListingPriceUsdc && item.request.query_parameters.some(parameter =>
        parameter.name === 'mode' && parameter.enum?.includes('server-error')))
    if (!listing) throw new Error('No controlled-failure listing is declared by discovery')
    return listing
  }

  buildRequest(listing: PublicAgentListing, options: { body?: unknown; path?: string } = {}) {
    const upstreamBody = options.body ?? listing.request.body.example
    if (listing.proxy_style === 'path') {
      return {
        url: this.url(listing.proxy_url),
        init: {
          method: listing.method,
          headers: new Headers(upstreamBody !== null && upstreamBody !== undefined ? { 'Content-Type': 'application/json' } : undefined),
          ...(listing.method !== 'GET' && upstreamBody !== null && upstreamBody !== undefined
            ? { body: JSON.stringify(upstreamBody) } : {}),
        } satisfies RequestInit,
      }
    }
    const envelope: Record<string, unknown> = {
      api_id: listing.id,
      buyer_wallet: this.signer.address,
      method: listing.method,
    }
    if (options.path) envelope.path = options.path
    if (listing.method !== 'GET' && upstreamBody !== null && upstreamBody !== undefined) envelope.body = upstreamBody
    return {
      url: this.url(listing.proxy_url),
      init: { method: 'POST', headers: new Headers({ 'Content-Type': 'application/json' }), body: JSON.stringify(envelope) } satisfies RequestInit,
    }
  }

  async probe(request: { url: string; init: RequestInit }) {
    const response = await this.fetcher(request.url, request.init)
    if (response.status !== 402) throw new Error(`Expected 402 probe, received ${response.status}`)
    const header = response.headers.get('payment-required')
    if (!header) throw new Error('402 omitted PAYMENT-REQUIRED')
    const challenge = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as PaymentRequired
    if (challenge.x402Version !== 2 || !Array.isArray(challenge.accepts)) throw new Error('Unsupported x402 challenge')
    const accepted = challenge.accepts.find(item => item.network === 'eip155:5042')
    if (!accepted || accepted.scheme !== 'exact') throw new Error('Arc Mainnet exact payment is not offered')
    if (!this.paymentRecipient || !this.paymentDomain) throw new Error('Discovery must be completed before payment')
    if (accepted.asset.toLowerCase() !== '0x3600000000000000000000000000000000000000') throw new Error('Unexpected payment asset')
    if (!/^0x[\da-f]{40}$/i.test(accepted.payTo) || !/^0x[\da-f]{40}$/i.test(accepted.extra?.verifyingContract)) throw new Error('Invalid payment destination')
    if (accepted.payTo.toLowerCase() !== this.paymentRecipient.toLowerCase()) throw new Error('Payment destination differs from discovery')
    if (accepted.extra.name !== this.paymentDomain.name || accepted.extra.version !== this.paymentDomain.version ||
      accepted.extra.verifyingContract.toLowerCase() !== this.paymentDomain.verifyingContract.toLowerCase()) {
      throw new Error('Payment domain differs from discovery')
    }
    if (!/^\d+$/.test(accepted.amount) || BigInt(accepted.amount) <= BigInt(0)) throw new Error('Invalid payment amount')
    const maxBuyerAtomic = BigInt(Math.ceil(this.maxListingPriceUsdc * 1.1 * 1_000_000))
    if (BigInt(accepted.amount) > maxBuyerAtomic) throw new Error('Payment exceeds live-test ceiling')
    if (!Number.isInteger(accepted.maxTimeoutSeconds) || accepted.maxTimeoutSeconds < 60) throw new Error('Invalid payment expiry')
    return { challenge, accepted }
  }

  async paymentSignature(challenge: PaymentRequired, accepted: PaymentRequirement) {
    const now = Math.floor(Date.now() / 1000)
    const bytes = new Uint8Array(32); crypto.getRandomValues(bytes)
    const nonce = `0x${Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')}`
    const authorization = {
      from: this.signer.address, to: accepted.payTo, value: accepted.amount,
      // Installed Circle batching requires at least seven days of authorization
      // validity; the resource maxTimeoutSeconds is not that validity window.
      validAfter: String(now - 600), validBefore: String(now + 604900), nonce,
    }
    const signature = await this.signer.signTypedData({
      domain: { name: accepted.extra.name, version: accepted.extra.version, chainId: 5042,
        verifyingContract: accepted.extra.verifyingContract as `0x${string}` },
      types: { TransferWithAuthorization: [
        { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
      ] },
      primaryType: 'TransferWithAuthorization',
      message: { ...authorization, value: BigInt(authorization.value), validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore) },
    })
    return Buffer.from(JSON.stringify({ x402Version: 2, payload: { authorization, signature },
      resource: challenge.resource, accepted })).toString('base64')
  }

  async execute(listing: PublicAgentListing, options: { body?: unknown; path?: string } = {}) {
    if (listing.price_per_call_usdc > this.maxListingPriceUsdc) throw new Error('Listing exceeds live-test ceiling')
    const request = this.buildRequest(listing, options)
    const { challenge, accepted } = await this.probe(request)
    const paymentSignature = await this.paymentSignature(challenge, accepted)
    const headers = new Headers(request.init.headers); headers.set('Payment-Signature', paymentSignature)
    const paid = await this.fetcher(request.url, { ...request.init, headers })
    const paymentResponse = paid.headers.get('payment-response')
    if (!paymentResponse) throw new Error('Paid response omitted PAYMENT-RESPONSE')
    const settlement = JSON.parse(Buffer.from(paymentResponse, 'base64').toString('utf8')) as { success?: boolean; network?: string; transaction?: string }
    if (settlement.success !== true || settlement.network !== 'eip155:5042') throw new Error('Invalid settlement response')
    const data = await paid.json() as Record<string, unknown>
    const capability = data.purchase_access_token
    if (typeof capability !== 'string' || !capability) throw new Error('Paid response omitted purchase capability')
    await this.capabilities.set(this.signer.address, listing.id, capability)
    return { request, paymentSignature, response: paid, data, settlement }
  }

  async retrieve(listing: PublicAgentListing) {
    const capability = await this.capabilities.get(this.signer.address, listing.id)
    if (!capability) throw new Error('No persisted purchase capability')
    const url = new URL('/api/calls/last-response', this.baseUrl)
    url.searchParams.set('api_id', listing.id); url.searchParams.set('buyer_wallet', this.signer.address)
    const response = await this.fetcher(url, { headers: { 'x-mahshar-purchase-access': capability } })
    if (!response.ok) throw new Error(`Purchase retrieval failed (${response.status})`)
    return response.json()
  }

  async replay(execution: Awaited<ReturnType<MahsharPublicAgent['execute']>>) {
    const headers = new Headers(execution.request.init.headers); headers.set('Payment-Signature', execution.paymentSignature)
    const response = await this.fetcher(execution.request.url, { ...execution.request.init, headers })
    const paymentResponse = response.headers.get('payment-response')
    if (!paymentResponse) throw new Error('Replay omitted PAYMENT-RESPONSE')
    const settlement = JSON.parse(Buffer.from(paymentResponse, 'base64').toString('utf8')) as { transaction?: string }
    if (settlement.transaction !== execution.settlement.transaction) throw new Error('Replay changed settlement identity')
    const data = await response.json() as Record<string, unknown>
    if (data.attemptId !== execution.data.attemptId) throw new Error('Replay changed settlement attempt')
    return { response, data, settlement }
  }
}
