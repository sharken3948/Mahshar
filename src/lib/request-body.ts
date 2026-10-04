export class RequestBodyError extends Error {
  constructor(readonly code: 'body_too_large' | 'invalid_json') { super(code) }
}

export async function readBoundedText(request: Request, maxBytes: number): Promise<string> {
  const contentLength = request.headers.get('content-length')
  if (contentLength !== null) {
    const declared = Number(contentLength)
    if (Number.isFinite(declared) && declared > maxBytes) throw new RequestBodyError('body_too_large')
  }
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      void reader.cancel().catch(() => undefined)
      throw new RequestBodyError('body_too_large')
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { throw new RequestBodyError('invalid_json') }
}

export async function readBoundedJson<T>(request: Request, maxBytes: number): Promise<T> {
  const text = await readBoundedText(request, maxBytes)
  try { return JSON.parse(text) as T }
  catch { throw new RequestBodyError('invalid_json') }
}
