export class RequestBodyError extends Error {
  constructor(readonly code: 'body_too_large' | 'invalid_json') { super(code) }
}

export async function readBoundedJson<T>(request: Request, maxBytes: number): Promise<T> {
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) throw new RequestBodyError('body_too_large')
  const text = await request.text()
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new RequestBodyError('body_too_large')
  try { return JSON.parse(text) as T }
  catch { throw new RequestBodyError('invalid_json') }
}
