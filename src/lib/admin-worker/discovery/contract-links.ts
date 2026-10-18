import { canonicalExternalUrl } from './sanitize'

/** Read literal references only; never execute scripts, guess paths or follow a page's base element. */
export function officialContractLinks(body: string, pageUrl: string): { url: string; kind: 'contract' | 'docs' }[] {
  const html = body.slice(0, 256 * 1024).replace(/<!--[\s\S]*?-->/g, '')
  const found = new Map<string, 'contract' | 'docs'>()
  const add = (raw: string, kind: 'contract' | 'docs') => {
    if (found.size >= 16 || /[\\\s]/.test(raw)) return
    try {
      const decoded = raw.replace(/&amp;/gi, '&')
      const resolved = new URL(decoded, pageUrl)
      // Canonicalization must not turn a signed/authenticated URL into a different request.
      if (resolved.search || resolved.hash) return
      const url = canonicalExternalUrl(resolved.toString())
      if (url && url !== pageUrl) found.set(url, kind)
    } catch { /* Ignore malformed individual references. */ }
  }
  for (const match of html.matchAll(/<(a|link|redoc)\b([^>]{0,4096})>/gi)) {
    const attrs = match[2]
    const ref = /(?:^|\s)(?:href|spec-url)\s*=\s*(["'])([^"']{1,2048})\1/i.exec(attrs)
    if (!ref) continue
    if (/\.(?:css|js|svg|png|jpg|woff2?)(?:[?#]|$)/i.test(ref[2])) continue
    const following = html.slice(match.index! + match[0].length, match.index! + match[0].length + 1024)
    const anchorText = match[1].toLowerCase() === 'a' ? following.split(/<\/a\s*>/i, 1)[0].replace(/<[^>]*>/g, ' ') : ''
    const label = `${attrs} ${anchorText}`
    if (match[1].toLowerCase() === 'redoc' || /\b(?:openapi|swagger)\b/i.test(label)) add(ref[2], 'contract')
    else if (/\b(?:api\s+reference|documentation|docs|developers?)\b/i.test(label)) add(ref[2], 'docs')
  }
  for (const match of html.matchAll(/SwaggerUI(?:Bundle)?\s*\(\s*\{([^}]{0,8192})\}/g)) {
    const url = /\burl\s*:\s*(["'])([^"']{1,2048})\1/.exec(match[1])
    if (url) add(url[2], 'contract')
  }
  return [...found].map(([url, kind]) => ({ url, kind }))
    .sort((a, b) => Number(a.kind === 'docs') - Number(b.kind === 'docs'))
}
