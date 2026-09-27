import {
  guardTestMatrixRequest,
  parseRequiredJsonBody,
  requireTestMatrixSecret,
  respondForTestMatrixMode,
} from '@/lib/test-matrix/server'

export const runtime = 'nodejs'

async function handle(request: Request) {
  const rejected = guardTestMatrixRequest(request, 'PUT')
  if (rejected) return rejected

  const authorization = request.headers.get('authorization')
  const unauthorized = requireTestMatrixSecret(
    authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : null,
    'TEST_MATRIX_BEARER_PUT_SECRET',
  )
  if (unauthorized) return unauthorized

  const parsed = await parseRequiredJsonBody(request)
  if ('response' in parsed) return parsed.response

  return respondForTestMatrixMode(request, {
    ok: true,
    method: 'PUT',
    auth: 'bearer',
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
