export type WorkerIdentityType = 'domain' | 'github_org' | 'postman_team' | 'rapidapi_org'

import { domainToASCII } from 'node:url'
import { getDomain } from 'tldts'
import { isOutboundUrlShapeAllowed } from '@/lib/outbound-fetch'

const SERVICE_PREFIXES = new Set(['api', 'apis', 'developer', 'developers', 'dev', 'docs'])
const SHARED_HOST_SUFFIXES = new Set([
  'readme.io', 'gitbook.io', 'gitbook.com', 'github.io', 'notion.site', 'vercel.app',
  'netlify.app', 'herokuapp.com', 'pages.dev',
])

function parseDomainHostname(value: string): string {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`
  let url: URL
  try { url = new URL(withScheme) } catch { throw new Error('worker_identity_invalid') }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('worker_identity_invalid')
  const hostname = domainToASCII(url.hostname.toLowerCase().replace(/\.$/, ''))
  if (!hostname || hostname.length > 253) throw new Error('worker_identity_invalid')
  if (!isOutboundUrlShapeAllowed(`https://${hostname}/`)) throw new Error('worker_identity_reserved_host')
  return hostname
}

function isSharedHost(hostname: string): boolean {
  return [...SHARED_HOST_SUFFIXES].some(suffix => hostname === suffix || hostname.endsWith(`.${suffix}`))
}

function registrableCandidate(hostname: string): string {
  if (isSharedHost(hostname)) {
    if (SHARED_HOST_SUFFIXES.has(hostname)) throw new Error('worker_identity_shared_host')
    return hostname
  }
  const registrable = getDomain(hostname, { allowPrivateDomains: true })
  if (!registrable) throw new Error('worker_identity_invalid')
  const prefix = hostname.slice(0, -(registrable.length + 1))
  return prefix && !prefix.includes('.') && SERVICE_PREFIXES.has(prefix) ? registrable : hostname
}

export function normalizeWorkerIdentity(type: WorkerIdentityType, value: string): string {
  const normalized = value.trim().toLowerCase()
  if (!normalized || normalized.length > 253) throw new Error('worker_identity_invalid')
  if (type === 'domain') {
    const hostname = parseDomainHostname(normalized)
    if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/.test(hostname)) {
      throw new Error('worker_identity_invalid')
    }
    return registrableCandidate(hostname)
  }
  const handle = normalized.replace(/^@/, '')
  if (!/^[a-z0-9](?:[a-z0-9_.-]{0,99})$/.test(handle)) throw new Error('worker_identity_invalid')
  return handle
}

export function normalizeWorkerProductKey(value: string): string {
  const tokens = value.normalize('NFKD').replace(/\p{M}+/gu, '').toLocaleLowerCase('und')
    .match(/[\p{L}\p{N}]+/gu) ?? []
  const isVersion = (token: string) => /^v?\d+(?:\.\d+)*$/u.test(token)
  const apiSuffix = (end: number): number => {
    if (tokens[end] === 'api') {
      if (['rest', 'restful', 'web'].includes(tokens[end - 1] ?? '')) return end - 1
      return end
    }
    return end + 1
  }
  let versionStart = tokens.length
  while (versionStart > 0 && isVersion(tokens[versionStart - 1])) versionStart -= 1
  const beforeVersion = apiSuffix(versionStart - 1)
  if (beforeVersion <= versionStart - 1) tokens.splice(beforeVersion, versionStart - beforeVersion)
  const trailing = apiSuffix(tokens.length - 1)
  if (trailing <= tokens.length - 1) tokens.splice(trailing)
  const normalized = tokens.join('-')
  if (!normalized || normalized.length > 160) throw new Error('worker_product_key_invalid')
  return normalized
}
