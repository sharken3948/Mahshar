import { parse as parseYaml } from 'yaml'
import { canonical, domain, lead, providerDocument, type Lead } from './model'
import { Network, safeEndpoint, safeUrl, type Page } from './network'

export const SOURCES = [
  'https://www.freepublicapis.com/api/apis?limit=1000',
  'https://raw.githubusercontent.com/public-apis/public-apis/master/README.md',
  'https://raw.githubusercontent.com/marcelscruz/public-apis/master/README.md',
  'https://raw.githubusercontent.com/public-api-lists/public-api-lists/master/README.md',
]
export function catalog(body: string, source: string): Lead[] {
  const rows: Lead[] = []
  if (new URL(source).hostname === 'www.freepublicapis.com') {
    let entries: unknown
    try { entries = JSON.parse(body) } catch { return [] }
    if (!Array.isArray(entries)) return []
    for (const value of entries) {
      if (!value || typeof value.title !== 'string' || typeof value.documentation !== 'string') continue
      const item = lead({ name: value.title, description: String(value.description ?? ''), docs: value.documentation,
        sources: [source, ...(typeof value.source === 'string' && safeUrl(value.source) ? [value.source] : [])], auth: 'unknown' })
      if (item) rows.push(item)
    }
    return rows
  }
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith('|')) continue
    const cells = line.split('|').slice(1, -1).map(x => x.trim())
    const link = cells[0]?.match(/^\[([^\]]+)\]\((https:\/\/[^\s)]+)\)$/)
    if (!link || cells.length < 4) continue
    // Parse actual service tables; never admit MCP/install/tool tables as APIs.
    const auth = cells[2].replace(/[`\s]/g, '').toLowerCase()
    const https = cells[3].replace(/[`\s]/g, '').toLowerCase()
    if (!['yes', 'no', 'unknown', ''].includes(https)) continue
    const item = lead({ name: link[1], description: cells[1], docs: link[2], sources: [source],
      auth: ['no', ''].includes(auth) ? 'none' : /apikey|oauth|yes|key/i.test(auth) ? 'required' : 'unknown' })
    if (item) rows.push(item)
  }
  return rows
}
export async function discover(network: Network): Promise<{ leads: Lead[]; errors: string[] }> {
  const byDocs = new Map<string, Lead>(), errors: string[] = []
  for (const source of SOURCES) {
    try {
      const page = await network.page(source)
      if (page.status !== 200) throw new Error('catalog_unavailable')
      for (const item of catalog(page.body, source)) {
        const key = item.docs.replace(/\/$/, '')
        const previous = byDocs.get(key)
        if (previous) {
          previous.sources = [...new Set([...previous.sources, source])]
          if (item.auth === 'required') previous.auth = 'required'
        }
        else byDocs.set(key, item)
      }
    } catch { errors.push(source) }
  }
  const byId = new Map<string, Lead>()
  for (const item of byDocs.values()) {
    const previous = byId.get(item.id)
    if (previous) {
      previous.sources = [...new Set([...previous.sources, ...item.sources])]
      if (item.auth === 'required') previous.auth = 'required'
    }
    else byId.set(item.id, item)
  }
  return { leads: [...byId.values()], errors }
}
export function text(raw: string): string {
  return raw.replace(/<script\b[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(?:p|pre|code|div|li|h[1-6])>|<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
}
export function links(page: Page): string[] {
  if (!/(?:html|markdown|text\/plain|json)/i.test(page.type)) return []
  const content = page.body.replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<style\b[\s\S]*?<\/style>/gi, '')
  return [...content.matchAll(/(?:href\s*=\s*["']|\[[^\]\n]+\]\()([^\s"')<>]+)/gi)].flatMap(m => {
    if (/&(?:quot|lt|gt);|[\u0000-\u001f\uFFFD]/i.test(m[1])) return []
    try { const url = new URL(m[1].replace(/&amp;/g, '&'), page.url); url.hash = ''; return safeUrl(url.href) ? [url.href] : [] } catch { return [] }
  })
}
export function policyLinks(page: Page): string[] {
  return links(page).filter(url => {
    const path = new URL(url).pathname
    if (/\/(?:assets|fonts|_next|_astro)\/|\.(?:js|css|woff2?|ttf|png|svg)$/i.test(path) || /license-plates/i.test(path)) return false
    return /(?:^|[/_-])(?:terms|privacy|datenschutz|legal|licen[sc]e|licensing|commercial|usage-policy|acceptable-use|conditions|impressum|nutzungsbedingungen|termos|condiciones|villkor)(?:[/_.-]|$)/i.test(path)
  })
}
type Obj = Record<string, any> // OpenAPI is untrusted JSON; only selected primitive fields are used below.
export function specificationEndpoints(raw: string, documentUrl: string): string[] {
  if (!/^\s*\{/.test(raw) && !/^\s*(?:openapi|swagger)\s*:/m.test(raw)) return []
  let spec: Obj
  try { spec = parseYaml(raw, { maxAliasCount: 20, uniqueKeys: true }) as Obj } catch { return [] }
  const collection = spec?.collection ?? spec
  if (collection?.info?._postman_id || /postman/i.test(collection?.info?.schema ?? '')) {
    const variables = Object.fromEntries((Array.isArray(collection.variable) ? collection.variable : [])
      .filter((v: Obj) => typeof v.key === 'string' && v.value != null && typeof v.value !== 'object').map((v: Obj) => [v.key, String(v.value)]))
    const result: string[] = []
    const walk = (items: unknown, depth = 0) => {
      if (!Array.isArray(items) || depth > 8) return
      for (const item of items) {
        if (!item || typeof item !== 'object') continue
        const request = item.request
        if (request?.method === 'GET' && !(request.auth ?? collection.auth)?.type?.match(/^(?!noauth$).+/)) {
          const rawUrl = typeof request.url === 'string' ? request.url : request.url?.raw
          if (typeof rawUrl === 'string') {
            const concrete = rawUrl.replace(/\{\{([^}]+)\}\}/g, (_: string, key: string) => variables[key] ?? `{{${key}}}`)
            if (safeEndpoint(concrete)) result.push(concrete)
          }
        }
        walk(item.item, depth + 1)
      }
    }
    walk(collection.item)
    return [...new Set(result)]
  }
  if (!spec || typeof spec !== 'object' || !(spec.openapi || spec.swagger)) return []
  const ref = (input: Obj, depth = 0): Obj => {
    if (!input || typeof input !== 'object' || depth > 8) return {}
    if (!input.$ref) return input
    if (typeof input.$ref !== 'string' || !input.$ref.startsWith('#/')) return {}
    let value = spec
    for (const key of input.$ref.slice(2).split('/').map((s: string) => s.replace(/~1/g, '/').replace(/~0/g, '~'))) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) return {}
      value = value?.[key]
    }
    return ref(value, depth + 1)
  }
  const servers = Array.isArray(spec.servers) ? spec.servers : spec.host ? [{ url: `https://${spec.host}${spec.basePath ?? ''}` }] : [{ url: '/' }]
  const found: string[] = []
  for (const [path, rawItem] of Object.entries(spec.paths ?? {})) {
    const item = ref(rawItem as Obj), operation = ref(item.get)
    const security = operation.security ?? spec.security ?? []
    if (!item.get || operation.deprecated || security.length && security.every((s: Obj) => Object.keys(s).length)) continue
    for (const server of operation.servers ?? item.servers ?? servers) {
      if (typeof server.url !== 'string') continue
      let base = server.url.replace(/\{([^}]+)\}/g, (_: string, name: string) => String(server.variables?.[name]?.default ?? `{${name}}`))
      if (!base.startsWith('https://')) { try { base = new URL(base, documentUrl).href } catch { continue } }
      let concrete = path, valid = true
      const query = new URLSearchParams()
      for (const rawParam of [...(item.parameters ?? []), ...(operation.parameters ?? [])]) {
        const parameter = ref(rawParam), schema = ref(parameter.schema ?? {})
        const example = parameter.example ?? Object.values(parameter.examples ?? {}).map((v: any) => ref(v).value)[0]
          ?? schema.example ?? schema.default ?? schema.enum?.[0] ?? parameter.default ?? parameter.enum?.[0]
        if (parameter.required && (example == null || typeof example === 'object')) { valid = false; break }
        if (example == null || typeof example === 'object') continue
        if (parameter.in === 'path') concrete = concrete.replace(`{${parameter.name}}`, encodeURIComponent(String(example)))
        if (parameter.in === 'query' && parameter.required) query.set(parameter.name, String(example))
        if (parameter.in === 'header' && parameter.required) valid = false
      }
      if (!valid) continue
      try {
        const url = new URL(base.replace(/\/$/, '') + '/' + concrete.replace(/^\//, ''))
        query.forEach((v, k) => url.searchParams.set(k, v))
        if (safeEndpoint(url.href)) found.push(url.href)
      } catch { /* no concrete documented URL */ }
    }
  }
  return [...new Set(found)]
}
export function examples(page: Page, provider: Lead): string[] {
  const plain = text(page.body).replace(/\\\r?\n/g, '')
  // Upgrade documented HTTP examples to HTTPS; plaintext requests are never sent.
  const trim = (url: string) => url.replace(/[),;.\]}]+$/, '').replace(/^http:\/\//i,'https://')
  const explicit = new Set([...plain.matchAll(/(?:\bGET\s+(?:(?!\b(?:POST|PUT|PATCH|DELETE)\b)[\s\S]){0,180}?|curl\s+(?:-X\s+GET\s+)?|(?:fetch|axios\.get|requests\.get)\s*\(\s*)[`"']?(https?:\/\/[^\s`"'<>\\]+)/gi)]
    .map(m => trim(m[1])))
  const codeBlocks = [...page.body.matchAll(/<(?:pre|code)\b[^>]*>([\s\S]*?)<\/(?:pre|code)>|```[^\n]*\n([\s\S]*?)```/gi)]
    .map(match => text(match[1] ?? match[2]))
    .filter(code => !/\b(?:POST|PUT|PATCH|DELETE)\b|\bcurl\b[^\n]*\s(?:-d|--data|-F|--form)\b/i.test(code))
  const urls = [...explicit, ...codeBlocks.flatMap(code => [...code.matchAll(/https?:\/\/[^\s`"'<>\\]+/g)].map(m => trim(m[0])))]
  for (const line of plain.split(/\r?\n/)) {
    if (!/\bcurl\b/.test(line) || !/(?:--get\b|\s-G\b)/.test(line)) continue
    const endpoint = line.match(/https:\/\/[^\s`"'<>\\]+/)?.[0]
    if (!endpoint) continue
    try {
      const url = new URL(trim(endpoint))
      for (const match of line.matchAll(/(?:--data(?:-urlencode)?|-d)\s+(?:'([^']*)'|"([^"]*)")/g)) {
        const pair = match[1] ?? match[2], separator = pair.indexOf('=')
        if (separator > 0) url.searchParams.set(pair.slice(0, separator), pair.slice(separator + 1))
      }
      urls.unshift(url.href)
    } catch { /* incomplete example */ }
  }
  for (const match of page.body.matchAll(/<input\b(?=[^>]*(?:readonly|(?:id|name)=["'][^"']*(?:api|endpoint|url)))[^>]*\bvalue=["'](https:\/\/[^"']+)["'][^>]*>/gi)) urls.push(text(match[1]))
  const documented = new Set(urls.map(canonical))
  const hostedDocs = new URL(provider.docs).hostname.endsWith('.github.io') || ['github.com','githubusercontent.com','readme.io','readthedocs.io','gitbook.io','gitbook.com','postman.com','postman.co','postman.io','stoplight.io','zenn.dev'].includes(domain(provider.docs))
  const selectedBase = page.body.match(/<select\b[^>]*\bid=["']baseUrl["'][^>]*>([\s\S]*?)<\/select>/i)?.[1]
    ?.match(/<option\b[^>]*value=["'](https:\/\/[^"']+)["']/i)?.[1]
  const base = plain.match(/(?:base\s*(?:url|endpoint)|API\s*(?:url|endpoint))\s*[:=]?\s*[`"']?(https:\/\/[^\s`"'<>]+)/i)?.[1] ?? selectedBase
  for (const m of plain.matchAll(/\bGET\s+[`"']?(\/[^\s`"'<>]+)/g)) {
    try { urls.push(base ? base.replace(/\/$/, '') + m[1] : new URL(m[1], page.url).href) } catch { /* incomplete sample */ }
  }
  for (const code of codeBlocks) {
    for (const m of code.matchAll(/(?:\bGET\s+|(?:fetch|axios\.get|requests\.get)\s*\(\s*["']\s*)(\/[^\s`"'<>]+)/g)) {
      try { urls.push(new URL(m[1],base ?? page.url).href) } catch { /* incomplete sample */ }
    }
    if (base) for (const m of code.matchAll(/\{base\}(\/[^\s`"'<>]+)/g)) {
      try { urls.push(new URL(m[1],base).href) } catch { /* incomplete sample */ }
    }
  }
  // A JSON link can be a partner review, build configuration or download.
  // Admit linked data only when its visible label documents an API/data response.
  for (const match of page.body.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    if (!/\b(?:json|csv|api endpoint|json endpoint|data endpoint)\b/i.test(text(match[2]))) continue
    try {
      const url = new URL(text(match[1]),page.url).href
      if (domain(url) === domain(provider.docs)) urls.push(url)
    } catch { /* malformed documentation link */ }
  }
  return [...new Set(urls.map(canonical).filter((url): url is string => !!url && safeEndpoint(url)
    && (providerDocument(url,provider.docs) || providerDocument(url,page.url) && !page.url.includes('freepublicapis.com/') || hostedDocs && documented.has(url))
    && !/\.(?:js|py|rb|sh|go|rs|ts|css|png|jpg|svg|gif|md|ya?ml|html|pdf|zip|tar|gz|http)$/i.test(new URL(url).pathname)
    && !/(?:\/docs|\/documentation|\/terms|\/privacy|\/pricing|\/license)(?:\/|$)/i.test(new URL(url).pathname)
    && (new URL(url).pathname !== '/' || /\b(?:GET|fetch|curl|requests.get)\b/i.test(plain))))]
}
export async function documentation(item: Lead, network: Network): Promise<{ pages: Page[]; endpoints: string[]; endpointDocs: Record<string, string> }> {
  let first = item.docs
  const github = new URL(first)
  if (github.hostname === 'github.com') {
    const parts = github.pathname.split('/').filter(Boolean)
    first = `https://raw.githubusercontent.com/${parts[0]}/${parts[1]}/${parts[2] === 'blob' ? parts.slice(3).join('/') : 'HEAD/README.md'}`
  }
  const pending = [first], visited = new Set<string>(), pages: Page[] = [], endpoints = new Set<string>()
  const explicitDocuments = new Set<string>()
  const endpointDocs: Record<string, string> = {}
  let failure: unknown
  const add = (page: Page) => {
    const options = [...specificationEndpoints(page.body, page.url), ...examples(page, item)]
    for (const endpoint of options) {
      endpoints.add(endpoint); endpointDocs[endpoint] = page.url
    }
    return options
  }
  // A shallow documentation walk, not a crawler or a provider request quota.
  for (let depth = 0; depth < 4 && pending.length; depth++) {
    const level = pending.splice(0)
    for (const url of level) {
      if (visited.has(url)) continue
      if (depth > 0 && endpoints.size && !explicitDocuments.has(url) && !/openapi|swagger|api-docs|api[_-]?spec/i.test(url)) continue
      visited.add(url)
      let page: Page
      try { page = await network.page(url) } catch (error) { failure = error; continue }
      if (page.status !== 200) continue
      pages.push(page)
      add(page)
      const plainDocumentation = /text\/plain/i.test(page.type) && /(?:^\s*#|\b(?:GET\s+https?:|curl\b|fetch\s*\(|API documentation)|^\s*(?:openapi|swagger)\s*:)/im.test(page.body)
      if (/(?:json|image\/|csv|text\/plain)/i.test(page.type) && !plainDocumentation && safeEndpoint(page.url) && !/(?:openapi|swagger|schema)/i.test(page.url)) {
        endpoints.add(page.url); endpointDocs[page.url] = page.url
      }
      try {
        const object = JSON.parse(page.body)
        if (object && !Array.isArray(object) && typeof object === 'object') {
          const values = Object.values(object)
          if (values.length && values.every(value => typeof value === 'string' && /^https:\/\//.test(value))) {
            for (const value of values as string[]) if (safeEndpoint(value) && new URL(value).origin === new URL(page.url).origin) {
              endpoints.add(value); endpointDocs[value] = page.url
            }
          }
        }
      } catch { /* non-JSON documentation */ }
      {
        const productRoot = new URL(page.url).pathname.match(/^(.+?)\/(?:docs|documentation|reference)(?:\/|$)/i)?.[1]
        const documentationPage = /\/(?:docs|documentation|reference)(?:\/|$)/i.test(new URL(page.url).pathname)
          || /^(?:docs|developer|developers)\./i.test(new URL(page.url).hostname)
        const navigationBody = page.body.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,'')
        const contentBody = documentationPage ? navigationBody.replace(/<(nav|aside|header|footer|devsite-book-nav)\b[^>]*>[\s\S]*?<\/\1>/gi,'') : navigationBody
        const relevant = depth === 0 ? links({ ...page, body: contentBody }).filter(link => domain(link) === domain(page.url)
          // Shared provider navigation can list hundreds of unrelated products.
          // Stay in this API's documentation; explicitly configured specs below
          // are still followed regardless of their location on the provider host.
          && (!productRoot || new URL(link).pathname.startsWith(productRoot + '/') || /(?:openapi|swagger|api-docs|api[_-]?spec)/i.test(link))
          && /(?:openapi|swagger|\/docs(?:\/|$)|documentation|\/[\w-]*api(?:\/|$)|quickstart|examples|reference)/i.test(link)
          && (!endpoints.size || /openapi|swagger|api-docs|api[_-]?spec/i.test(link))
          && !/\.(?:js|css|svg|png|jpg)$/i.test(new URL(link).pathname)) : []
        const configured = [...page.body.matchAll(/(?:spec-url\s*=|\b(?:url|configUrl|openapi|swagger)["']?\s*:|\bfetch\s*\()\s*["']([^"']+)['"]/gi)]
          .flatMap(match => { try {
            // Documentation generators may append an operation selector to a spec
            // reference. That selector is not part of the document's URL.
            const reference = match[1].replace(/\s+(?:get|post|put|patch|delete|head|options)\s+\/.*$/i, '')
            if (/\s/.test(reference)) return []
            const url = new URL(reference, page.url)
            return domain(url.href) === domain(page.url) && /openapi|swagger|api-docs|spec|\.(?:json|ya?ml)$/i.test(url.pathname) && safeUrl(url.href) ? [url.href] : []
          } catch { return [] } })
        const initializers = [...page.body.matchAll(/<script\b[^>]*\bsrc=["']([^"']*swagger-initializer\.js)["']/gi)]
          .flatMap(match => { try { const url = new URL(match[1],page.url); return domain(url.href) === domain(page.url) && safeUrl(url.href) ? [url.href] : [] } catch { return [] } })
        for (const url of [...configured,...initializers]) explicitDocuments.add(url)
        // Shared navigation repeats entire reference trees. Follow their linked
        // overview, not every descendant operation before trying an API example.
        const navigation = relevant.filter(link => !visited.has(link)).filter(link =>
          /openapi|swagger|api-docs|api[_-]?spec/i.test(link) || !relevant.some(parent => parent !== link
            && !visited.has(parent) && new URL(link).origin === new URL(parent).origin
            && new URL(link).pathname.startsWith(new URL(parent).pathname.replace(/\/$/,'')+'/')))
        pending.push(...new Set([...configured, ...initializers, ...navigation]))
        const migration = text(page.body).match(/(?:migrated|moved|relocated)[\s\S]{0,120}?(https:\/\/[^\s<>"']+)/i)?.[1]
        if (!endpoints.size && migration && safeUrl(migration)) {
          const moved = new URL(migration)
          pending.unshift(moved.hostname === 'github.com' ? `https://raw.githubusercontent.com/${moved.pathname.split('/').filter(Boolean).slice(0, 2).join('/')}/HEAD/README.md` : moved.href)
        }
      }
    }
    // A root URL or a first example must not hide an explicitly linked schema.
    // Generic navigation stops once examples exist; direct specs remain finite.
  }
  // Curated service pages supply documented examples when provider docs are a JS
  // shell or moved. They are never used as commercial-permission authority.
  for (const source of item.sources.filter(url => new URL(url).hostname === 'freepublicapis.com')) {
    try {
      const page = await network.page(source)
      if (page.status === 200) {
        const before = [...endpoints], specific = add(page)
        const resourceWords = (endpoint: string) => new URL(endpoint).pathname.toLowerCase().replace(/\.(?:json|xml|csv)$/,'').split(/[^a-z0-9]+/)
          .filter(word => word.length > 2 && !/^(?:api|apis|data|search|query|random|all|any|get|list|latest|generate|v\d+|\d+)$/.test(word))
          .map(word => word.length > 3 ? word.replace(/s$/,'') : word)
        const resources = new Set(specific.flatMap(resourceWords))
        const related = resources.size ? before.filter(endpoint => resourceWords(endpoint).some(word => resources.has(word))) : before
        endpoints.clear(); for (const endpoint of [...specific,...related]) endpoints.add(endpoint)
      }
    } catch (error) { failure ??= error }
  }
  for (const endpoint of item.endpoints ?? []) {
    // Recovered/example endpoints must occur in fetched documentation, never invented.
    const documented = pages.find(page => text(page.body).includes(endpoint))
    if (documented && safeEndpoint(endpoint)) { endpoints.add(endpoint); endpointDocs[endpoint] = documented.url }
  }
  if (!pages.length && !endpoints.size && failure) throw failure
  // On multi-service provider pages, try the named resource before other
  // documented alternatives. This is ordering only, with no qualification score.
  const words = item.name.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(word => word.length >= 2 && !/^(?:api|free|public|service|data|the|and)$/i.test(word))
  const named = [...endpoints].filter(endpoint => new URL(endpoint).pathname.toLowerCase().split(/[^\p{L}\p{N}]+/u).some(part => words.includes(part)))
  return { pages, endpoints: [...new Set([...named,...endpoints])], endpointDocs }
}
