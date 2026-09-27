import {
  guardTestMatrixRequest,
  respondForTestMatrixMode,
  sanitizedQuery,
} from '@/lib/test-matrix/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function handle(request: Request) {
  const rejected = guardTestMatrixRequest(request, 'GET')
  if (rejected) return rejected

  const url = new URL(request.url)
  return respondForTestMatrixMode(request, {
    ok: true,
    method: 'GET',
    path: url.pathname,
    query: sanitizedQuery(url),
    custom_header_received: request.headers.has('x-mahshar-test-header'),
  })
}

export const GET = handle
export const POST = handle
export const PUT = handle
export const PATCH = handle
export const DELETE = handle
export const HEAD = handle
export const OPTIONS = handle
