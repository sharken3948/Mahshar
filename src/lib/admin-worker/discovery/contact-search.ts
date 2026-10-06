import 'server-only'
import {
  WORKER_CONTACT_SEARCH_QUERY_LIMIT,
  WORKER_CONTACT_SEARCH_RESULT_LIMIT,
} from '../constants'
import { boundedDiscoveryFetch, type DiscoveryFetcher } from './fetch'
import { canonicalExternalUrl } from './sanitize'

export type ContactSearchResult = { url: string; title: string }

export type ContactSearchAdapter = {
  search: (query: string, limit: number) => Promise<ContactSearchResult[]>
}

function decodeXml(value: string): string {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
}

function structurallyValidRss(value: string): boolean {
  const withoutOpaqueSections = value
    .replace(/<\?xml\b[\s\S]*?\?>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
    .replace(/<!DOCTYPE\b[\s\S]*?>/gi, '')
  if (/<\?|<!--|<!\[CDATA\[|<!DOCTYPE\b/i.test(withoutOpaqueSections)) return false
  if (/&(?!#\d+;|#x[\da-f]+;|[a-z_][\w.:-]*;)/i.test(withoutOpaqueSections)) return false

  const stack: string[] = []
  const tags = withoutOpaqueSections.matchAll(/<\s*(\/?)\s*([a-z_][\w:.-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*(\/?)\s*>/gi)
  let cursor = 0
  let root = ''
  let rootClosed = false
  let channelSeen = false
  for (const match of tags) {
    const index = match.index ?? 0
    const between = withoutOpaqueSections.slice(cursor, index)
    if (/[<>]/.test(between) || (stack.length === 0 && between.trim())) return false
    cursor = index + match[0].length
    const closing = match[1] === '/'
    const name = (match[2] ?? '').toLowerCase()
    const selfClosing = match[3] === '/'
    if (closing) {
      if (selfClosing || stack.pop() !== name) return false
      continue
    }
    if (stack.length === 0) {
      if (root) return false
      root = name
    }
    if (name === 'channel' && stack.length === 1 && stack[0] === 'rss') channelSeen = true
    if (!selfClosing) stack.push(name)
    else if (stack.length === 0) rootClosed = true
  }
  const trailing = withoutOpaqueSections.slice(cursor)
  if (/[<>]/.test(trailing) || trailing.trim()) return false
  if (root && stack.length === 0) rootClosed = true
  return root === 'rss' && rootClosed && channelSeen && stack.length === 0
}

export function contactSearchQueries(providerName: string, domain: string): string[] {
  const name = providerName.replace(/["\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)
  return [
    `"${name}" contact`,
    `"${name}" support`,
    `"${name}" sales`,
    `site:${domain} contact`,
    `site:${domain} support`,
    `"${name}" GitHub`,
  ].slice(0, WORKER_CONTACT_SEARCH_QUERY_LIMIT)
}

export function createPublicContactSearchAdapter(fetcher: DiscoveryFetcher = boundedDiscoveryFetch): ContactSearchAdapter {
  return {
    async search(query, limit) {
      const boundedLimit = Math.min(Math.max(1, limit), WORKER_CONTACT_SEARCH_RESULT_LIMIT)
      const response = await fetcher(`https://www.bing.com/search?format=rss&q=${encodeURIComponent(query)}`, {
        maxBytes: 192 * 1024,
        accept: 'application/rss+xml,application/xml,text/xml',
      })
      if (response.status < 200 || response.status >= 300) throw new Error('contact_search_unavailable')
      if (!/(?:rss|xml)/i.test(response.contentType) || !structurallyValidRss(response.body)) {
        throw new Error('contact_search_malformed')
      }
      const results: ContactSearchResult[] = []
      for (const item of response.body.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
        const body = item[1] ?? ''
        const rawUrl = decodeXml(body.match(/<link>([\s\S]*?)<\/link>/i)?.[1]?.trim() ?? '')
        const url = canonicalExternalUrl(rawUrl)
        if (!url) continue
        const title = decodeXml(body.match(/<title>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? '')
          .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)
        results.push({ url, title })
        if (results.length >= boundedLimit) break
      }
      return results
    },
  }
}

export const publicContactSearchAdapter = createPublicContactSearchAdapter()
