import {
  guardTestMatrixRequest,
  parseOptionalJsonBody,
  requireTestMatrixSecret,
  respondForTestMatrixMode,
} from '@/lib/test-matrix/server'

export const runtime = 'nodejs'

async function handle(request: Request) {
  const rejected = guardTestMatrixRequest(request, 'DELETE')
  if (rejected) return rejected

  const url = new URL(request.url)
  const unauthorized = requireTestMatrixSecret(
    url.searchParams.get('mahshar_key'),
    'TEST_MATRIX_QUERY_DELETE_SECRET',
  )
  if (unauthorized) return unauthorized

  const parsed = await parseOptionalJsonBody(request)
  if ('response' in parsed) return parsed.response

  return respondForTestMatrixMode(request, {
    ok: true,
    method: 'DELETE',
    auth: 'queryparam',
    fixed: url.searchParams.get('fixed'),
    body_present: parsed.bodyPresent,
    body: parsed.body,
  })
}

export const GET = handle
export const POST = handle
export const PUT = handle
export const PATCH = handle
export const DELETE = handle
export const HEAD = handle
export const OPTIONS = handle
