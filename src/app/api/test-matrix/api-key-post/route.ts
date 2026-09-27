import {
  guardTestMatrixRequest,
  parseRequiredJsonBody,
  requireTestMatrixSecret,
  respondForTestMatrixMode,
} from '@/lib/test-matrix/server'

export const runtime = 'nodejs'

async function handle(request: Request) {
  const rejected = guardTestMatrixRequest(request, 'POST')
  if (rejected) return rejected

  const unauthorized = requireTestMatrixSecret(
    request.headers.get('x-api-key'),
    'TEST_MATRIX_API_KEY_POST_SECRET',
  )
  if (unauthorized) return unauthorized

  const parsed = await parseRequiredJsonBody(request)
  if ('response' in parsed) return parsed.response

  return respondForTestMatrixMode(request, {
    ok: true,
    method: 'POST',
    auth: 'x-api-key',
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
