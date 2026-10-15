/** Naming proof comes from provider body statements or typed schema.org data, never titles. */
export type OfficialNameProof = {
  kind: 'company' | 'product'
  name: string
  basis: 'provider_statement' | 'schema_org'
  quote?: string
  data?: { '@type': string; name: string; url: string; description?: string }
}
export type OfficialNameEvidence = OfficialNameProof & {
  sourceId: string; sourceType: string; sourceRole: string; url: string; checkedAt: string
}

export function validInvitationName(value: unknown): value is string {
  return typeof value === 'string' && value === value.trim() && value.length <= 200 && /[\p{L}\p{N}]/u.test(value)
    && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>@]/u.test(value) && !/:\/\//.test(value)
    && !/\[(?:company|api product)\]/i.test(value)
    && !/^(?:unknown|n\/?a|none|null|undefined|tbd)$/i.test(value)
}
export function validCommercialName(value: unknown, kind: 'company' | 'product'): value is string {
  return validInvitationName(value)
    && !/\b(?:documentation|swagger|test center|test environment|sandbox|demo|developer portal|api reference)\b|(?:^|[\s-])(?:production|staging)(?:$|[\s-])/i.test(value)
    && !/^(?:openapi|api docs?|developer docs?)$/i.test(value)
    && (kind !== 'company' || !/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(value))
}
export function ownsNamingUrl(value: unknown, domain: string): boolean {
  if (typeof value !== 'string' || !domain || domain !== domain.toLowerCase()) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && (url.hostname === domain || url.hostname.endsWith(`.${domain}`))
      && /^https:\/\/[a-z0-9.-]+(?:[/?#]|$)/.test(value)
  } catch { return false }
}
export function validOfficialNameProof(proof: OfficialNameProof, domain: string): boolean {
  if (!proof || !['company', 'product'].includes(proof.kind) || !validCommercialName(proof.name, proof.kind)) return false
  if (proof.basis === 'provider_statement') {
    const type = proof.kind === 'company' ? 'company' : 'API'
    return proof.quote === `Our ${type} is called ${proof.name}.` || proof.quote === `${proof.name} is our ${type}.`
  }
  const data = proof.data
  return proof.basis === 'schema_org' && !!data && data.name === proof.name && ownsNamingUrl(data.url, domain)
    && (proof.kind === 'company' ? data['@type'] === 'Organization'
      : ['Product', 'SoftwareApplication', 'WebAPI', 'Service'].includes(data['@type'])
        && typeof data.description === 'string' && data.description.length >= 10 && data.description.length <= 500
        && /\b(?:API|product|platform|service|software|solution|tool)\b/i.test(data.description)
        && (data['@type'] === 'WebAPI' || /\bAPIs?\b/i.test(`${data.name} ${data.description}`))
        && !/^(?:documentation|api (?:documentation|reference|docs?)|swagger|openapi (?:spec|doc)|developer portal|sandbox|demo|test center)\b/i.test(data.description.trim()))
}

export function resolveOfficialNames(domain: string, evidence: OfficialNameEvidence[] = [], now = Date.now()): { company: string | null; product: string | null } {
  if (!Array.isArray(evidence) || evidence.length > 64) return { company: null, product: null }
  const valid = evidence.filter(item => item && item.sourceType === 'website'
    && ['official_site', 'official_docs', 'official_pricing', 'official_contact'].includes(item.sourceRole)
    && typeof item.sourceId === 'string' && item.sourceId.length > 0 && ownsNamingUrl(item.url, domain)
    && Number.isFinite(Date.parse(item.checkedAt)) && Date.parse(item.checkedAt) >= now - 30 * 86400_000
    && Date.parse(item.checkedAt) <= now + 300_000 && validOfficialNameProof(item, domain))
  const unique = (kind: OfficialNameProof['kind']) => {
    const names = [...new Set(valid.filter(item => item.kind === kind).map(item => item.name))]
    return names.length === 1 ? names[0] : null
  }
  return { company: unique('company'), product: unique('product') }
}

/** Supplemental metadata only: consumes already-fetched official HTML; never fetches. */
export function officialNamesFromPage(url: string, body: string, domain: string): OfficialNameProof[] {
  if (!ownsNamingUrl(url, domain) || /^\s*[\[{]/.test(body)) return [] // OpenAPI info.title is never naming proof.
  if (body.length > 256 * 1024) return []
  let html = body.replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/<(template|pre|code|noscript|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
  for (let pass = 0; pass < 4; pass++) html = html.replace(/<([a-z][a-z0-9:-]*)\b[^>]*(?:\bhidden(?=\s|=|>)|\baria-hidden\s*=\s*["']true["']|\bstyle\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden)[^"']*["'])[^>]*>[\s\S]*?<\/\1>/gi, '')
  const proofs: OfficialNameProof[] = []; let overflow = false
  const visit = (value: unknown, depth = 0) => {
    if (depth > 3 || proofs.length > 8) { overflow = true; return }
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) { if (value.length > 16) overflow = true; value.slice(0, 16).forEach(item => visit(item, depth + 1)); return }
    const item = value as Record<string, unknown>
    if (item['@graph']) visit(item['@graph'], depth + 1)
    if (typeof item['@type'] !== 'string' || typeof item.name !== 'string' || typeof item.url !== 'string') return
    const kind = item['@type'] === 'Organization' ? 'company' : 'product'
    const proof: OfficialNameProof = { kind, name: item.name, basis: 'schema_org', data: {
      '@type': item['@type'], name: item.name, url: item.url,
      ...(typeof item.description === 'string' ? { description: item.description } : {}),
    } }
    if (validOfficialNameProof(proof, domain)) proofs.push(proof)
  }
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(script => /\btype\s*=\s*["']application\/ld\+json["']/i.test(script[1]))
  if (scripts.length > 8) return []
  for (const script of scripts) {
    if (script[2].length > 64 * 1024) { overflow = true; continue }
    try { visit(JSON.parse(script[2])) } catch { /* Malformed metadata proves nothing. */ }
  }
  const text = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
  const paragraphs = [...text.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
  if (paragraphs.length > 64) return []
  for (const paragraph of paragraphs) {
    const quote = paragraph[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
    const match = /^(?:Our (company|API) is called (.{1,200})\.|(.{1,200}) is our (company|API)\.)$/.exec(quote)
    if (!match) continue
    const proof: OfficialNameProof = { kind: (match[1] ?? match[4]) === 'company' ? 'company' : 'product', name: match[2] ?? match[3], basis: 'provider_statement', quote }
    if (validOfficialNameProof(proof, domain)) proofs.push(proof)
  }
  if (overflow || proofs.length > 8) return []
  return [...new Map(proofs.map(proof => [JSON.stringify(proof), proof])).values()].slice(0, 8)
}

export function officialNamingMetadata(url: string, body: string, domain: string): { namingEvidence: OfficialNameProof[] } {
  const namingEvidence = officialNamesFromPage(url, body, domain)
  return { namingEvidence } // A fresh page without proof clears superseded naming metadata.
}
