import 'server-only'

import { timingSafeEqual } from 'node:crypto'

export const TEST_MATRIX_SLOW_DELAY_MS = 10_500

export type TestMatrixMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'
export type TestMatrixSecretName =
  | 'TEST_MATRIX_API_KEY_POST_SECRET'
  | 'TEST_MATRIX_BEARER_PUT_SECRET'
  | 'TEST_MATRIX_QUERY_DELETE_SECRET'

const JSON_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
}

function json(body: unknown, status = 200, headers?: HeadersInit) {
  return Response.json(body, { status, headers: { ...JSON_HEADERS, ...headers } })
}

export function guardTestMatrixRequest(request: Request, allowedMethod: TestMatrixMethod): Response | null {
  if (process.env.ENABLE_TEST_MATRIX_ENDPOINTS !== 'true') {
    return json({ error: 'Not found' }, 404)
  }
  if (request.method !== allowedMethod) {
    return json({ error: 'Method not allowed' }, 405, { Allow: allowedMethod })
  }
  return null
}

function secretMatches(provided: string | null, expected: string): boolean {
  if (provided === null) return false
  const providedBytes = Buffer.from(provided)
  const expectedBytes = Buffer.from(expected)
  return providedBytes.length === expectedBytes.length && timingSafeEqual(providedBytes, expectedBytes)
}

export function requireTestMatrixSecret(provided: string | null, secretName: TestMatrixSecretName): Response | null {
  const expected = process.env[secretName]
  if (!expected) return json({ error: 'Test endpoint unavailable' }, 503)
  if (!secretMatches(provided, expected)) return json({ error: 'Unauthorized' }, 401)
  return null
}

export async function parseRequiredJsonBody(request: Request): Promise<{ body: unknown } | { response: Response }> {
  try {
    const raw = await request.text()
    if (!raw.trim()) return { response: json({ error: 'JSON body required' }, 400) }
    return { body: JSON.parse(raw) }
  } catch {
    return { response: json({ error: 'Invalid JSON body' }, 400) }
  }
}

export async function parseOptionalJsonBody(
  request: Request,
): Promise<{ bodyPresent: false; body: null } | { bodyPresent: true; body: unknown } | { response: Response }> {
  try {
    const raw = await request.text()
    if (!raw.trim()) return { bodyPresent: false, body: null }
    return { bodyPresent: true, body: JSON.parse(raw) }
  } catch {
    return { response: json({ error: 'Invalid JSON body' }, 400) }
  }
}

export function sanitizedQuery(url: URL): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {}
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key)
    query[key] = values.length === 1 ? values[0] : values
  }
  return query
}

export async function respondForTestMatrixMode(
  request: Request,
  successBody: unknown,
  options: { slowDelayMs?: number } = {},
): Promise<Response> {
  const mode = new URL(request.url).searchParams.get('mode') ?? 'default'
  if (mode === 'text') {
    return new Response('test-matrix-ok', {
      status: 200,
      headers: { ...JSON_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }
  if (mode === 'invalid-json') {
    return new Response('{"ok":', {
      status: 200,
      headers: { ...JSON_HEADERS, 'Content-Type': 'application/json; charset=utf-8' },
    })
  }
  if (mode === 'client-error') return json({ ok: false, error: 'Controlled client error' }, 400)
  if (mode === 'server-error') return json({ ok: false, error: 'Controlled server error' }, 500)
  if (mode === 'redirect') {
    return new Response(null, {
      status: 307,
      headers: {
        ...JSON_HEADERS,
        Location: '/api/test-matrix/public-get?redirected=1',
      },
    })
  }
  if (mode === 'slow') {
    await new Promise(resolve => setTimeout(resolve, options.slowDelayMs ?? TEST_MATRIX_SLOW_DELAY_MS))
    return json(successBody)
  }
  if (mode !== 'default') return json({ ok: false, error: 'Unsupported test mode' }, 400)
  return json(successBody)
}
