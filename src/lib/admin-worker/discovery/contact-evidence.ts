import type { ContactEvidence } from './types'

// Decode representations actually present in the document. Never evaluate scripts
// or construct a mailbox from a provider name or a presumed naming convention.
export function decodeContactEntities(value: string): string {
  return value.replace(/&#(x[0-9a-f]{1,6}|[0-9]{1,7});?/gi, (original, code: string) => {
    const number = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : parseInt(code, 10)
    return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff)
      ? String.fromCodePoint(number) : original
  }).replace(/&(commat|period|nbsp|amp|quot|apos);/gi, (_, name: string) =>
    ({ commat: '@', period: '.', nbsp: ' ', amp: '&', quot: '"', apos: "'" })[name.toLowerCase()]!)
}

export function contactDocument(body: string): string {
  return body.slice(0, 192 * 1024).replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
}

export function publishedEmails(body: string): string[] {
  const document = contactDocument(body)
  let text = decodeContactEntities(document.replace(/<[^>]*>/g, ' '))
  // Bracketed at/dot and spacing are explicit obfuscation; prose "at" is not.
  text = text.replace(/\s*[\[(]at[\])]\s*/gi, '@').replace(/\s*[\[(]dot[\])]\s*/gi, '.')
  const emails = [...text.matchAll(/(?<![\w@/])([a-z0-9][a-z0-9._%+-]{0,63})\s*@\s*([a-z0-9-]+(?:(?:\.|\s+\.\s*)[a-z0-9-]+)+)/gi)]
    .map(match => `${match[1]}@${match[2].replace(/\s+/g, '')}`)
  for (const match of document.matchAll(/(?:\bdata-cfemail\s*=\s*["']|\/cdn-cgi\/l\/email-protection#)([a-f0-9]{6,512})["']/gi)) {
    const encoded = match[1]
    if (encoded.length % 2) continue
    const key = parseInt(encoded.slice(0, 2), 16)
    const decoded = encoded.slice(2).match(/../g)!.map(byte => String.fromCharCode(parseInt(byte, 16) ^ key)).join('')
    if (!/[\x00-\x20\x7f]/.test(decoded)) emails.push(decoded)
  }
  for (const match of document.matchAll(/<meta\b[^>]*>/gi)) {
    if (!/itemprop\s*=\s*["']email["']/i.test(match[0])) continue
    const value = /content\s*=\s*["']([^"']+)["']/i.exec(match[0])?.[1]
    if (value) emails.push(decodeContactEntities(value))
  }
  // Structured contact data is publication, not executable JavaScript. Parse
  // only schema.org JSON-LD with explicit email fields and bounded traversal.
  const raw = body.slice(0, 192 * 1024).replace(/<!--[\s\S]*?-->/g, ' ')
  for (const match of raw.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(match[1])
      let remaining = 100
      const visit = (value: unknown, depth: number) => {
        if (!value || typeof value !== 'object' || depth > 8 || remaining-- <= 0) return
        if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return }
        const item = value as Record<string, unknown>
        const types = Array.isArray(item['@type']) ? item['@type'] : [item['@type']]
        if (types.some(type => ['Organization', 'Corporation', 'LocalBusiness', 'Person', 'ContactPoint'].includes(String(type)))
          && typeof item.email === 'string') emails.push(item.email.replace(/^mailto:/i, ''))
        for (const nested of Object.values(item)) visit(nested, depth + 1)
      }
      const roots = Array.isArray(data) ? data : [data]
      for (const item of roots) if (item && /^https?:\/\/schema\.org\/?$/.test(item['@context'])) visit(item, 0)
    } catch { /* Malformed JSON is not contact evidence. */ }
  }
  return [...new Set(emails.map(email => email.toLowerCase()))]
}

export function contactFormState(body: string): ContactEvidence['formState'] {
  const document = contactDocument(body)
  const forms = [...document.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/gi)].map(match => match[0])
  const form = forms.some(value => /<textarea\b/i.test(value)
    && /(?:type\s*=\s*["']email["']|name\s*=\s*["'][^"']*email[^"']*["'])/i.test(value))
  // Recognize a form embed, not a generic link to a form hosting service.
  const embedded = /<(?:iframe|div)\b[^>]*(?:src=["'][^"']*(?:typeform\.com\/to\/|forms\.hubspot\.com\/)|data-tf-(?:widget|live)=)/i.test(document)
    || /hbspt\.forms\.create\s*\(/i.test(body.slice(0, 192 * 1024))
  if (!form && !embedded) return undefined
  // A form can remain manual even when an embedded widget hides its controls.
  return /captcha|cf-turnstile|challenges\.cloudflare\.com\/turnstile/i.test(body.slice(0, 192 * 1024))
    || embedded ? 'manual_required' : 'available'
}
