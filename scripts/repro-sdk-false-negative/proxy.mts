import { createServer, IncomingMessage, ServerResponse } from 'node:http'

const UPSTREAM = 'https://rpc.testnet.arc.network'
const HOST = '127.0.0.1'
const PORT = 8546
const MIN_SPACING_MS = 250
const RETRY_DELAYS_MS = [1000, 2000, 3000, 4000, 5000, 6000]

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let lastForwardAt = 0
let throttleChain: Promise<void> = Promise.resolve()
function throttle(): Promise<void> {
  const next = throttleChain.then(async () => {
    const wait = MIN_SPACING_MS - (Date.now() - lastForwardAt)
    if (wait > 0) await sleep(wait)
    lastForwardAt = Date.now()
  })
  throttleChain = next.catch(() => {})
  return next
}

function isRateLimited(status: number, body: string): boolean {
  return status === 429 || body.toLowerCase().includes('request limit reached')
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function methodsOf(body: string): string[] {
  try {
    const parsed = JSON.parse(body)
    const arr = Array.isArray(parsed) ? parsed : [parsed]
    return arr.map((r) => (typeof r?.method === 'string' ? r.method : '<unknown>'))
  } catch {
    return ['<unparseable>']
  }
}

function shouldFail(methods: string[]): boolean {
  return methods.some((m) => m === 'eth_getTransactionReceipt')
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405).end('method not allowed')
    return
  }
  const body = await readBody(req)
  const methods = methodsOf(body)
  const label = methods.join(',')

  if (shouldFail(methods)) {
    console.log(`[proxy] ${label} -> injected 500`)
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'injected failure for repro' }))
    return
  }

  let lastStatus = 0
  let lastText = ''
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      await throttle()
      const upstream = await fetch(UPSTREAM, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      })
      lastStatus = upstream.status
      lastText = await upstream.text()
      if (isRateLimited(lastStatus, lastText) && attempt < RETRY_DELAYS_MS.length) {
        const delay = RETRY_DELAYS_MS[attempt]
        console.log(`[proxy] ${label} -> 429, retry ${attempt + 1}/${RETRY_DELAYS_MS.length} in ${delay / 1000}s`)
        await sleep(delay)
        continue
      }
      console.log(`[proxy] ${label} -> forwarded ${lastStatus}`)
      res.writeHead(lastStatus, { 'content-type': 'application/json' })
      res.end(lastText)
      return
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log(`[proxy] ${label} -> failed: ${msg}`)
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: `proxy upstream failed: ${msg}` }))
      return
    }
  }
}

const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`[proxy] handler error: ${msg}`)
    if (!res.headersSent) res.writeHead(500)
    res.end()
  })
})

server.listen(PORT, HOST, () => {
  console.log(`[proxy] listening on http://${HOST}:${PORT} -> ${UPSTREAM}`)
  console.log(`[proxy] will inject HTTP 500 for eth_getTransactionReceipt (including batches)`)
  console.log(`[proxy] throttle: ${MIN_SPACING_MS}ms min spacing; 429 retries: ${RETRY_DELAYS_MS.map((d) => d / 1000 + 's').join(', ')}`)
})
