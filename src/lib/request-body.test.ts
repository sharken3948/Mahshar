import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readBoundedJson, readBoundedText, RequestBodyError } from './request-body'

const LIMIT = 256 * 1024
const encoder = new TextEncoder()

function streamingRequest(chunks: Uint8Array[], headers?: HeadersInit, onCancel?: () => void) {
  let index = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index === chunks.length) { controller.close(); return }
      controller.enqueue(chunks[index++])
    },
    cancel() { onCancel?.() },
  })
  return new Request('https://mahshar.xyz/test', {
    method: 'POST', headers, body: stream, duplex: 'half',
  } as RequestInit & { duplex: 'half' })
}

test('declared oversized bodies fail before their stream is read', async () => {
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(encoder.encode('{}')); controller.close() } })
  const request = new Request('https://mahshar.xyz/test', {
    method: 'POST', headers: { 'content-length': String(LIMIT + 1) }, body: stream, duplex: 'half',
  } as RequestInit & { duplex: 'half' })
  await assert.rejects(readBoundedJson(request, LIMIT), (error: unknown) =>
    error instanceof RequestBodyError && error.code === 'body_too_large')
  assert.equal(request.bodyUsed, false)
})

test('chunked bodies stop buffering and cancel as soon as the byte limit is exceeded', async () => {
  let cancelled = false
  const request = streamingRequest([
    new Uint8Array(128 * 1024), new Uint8Array(128 * 1024), new Uint8Array(1), new Uint8Array(128 * 1024),
  ], undefined, () => { cancelled = true })
  await assert.rejects(readBoundedText(request, LIMIT), (error: unknown) =>
    error instanceof RequestBodyError && error.code === 'body_too_large')
  await Promise.resolve()
  assert.equal(cancelled, true)
})

test('exact-limit and under-limit JSON bodies remain valid', async () => {
  const exact = JSON.stringify({ x: 'a'.repeat(LIMIT - 8) })
  assert.equal(encoder.encode(exact).byteLength, LIMIT)
  assert.equal((await readBoundedJson<{ x: string }>(streamingRequest([encoder.encode(exact)]), LIMIT)).x.length, LIMIT - 8)
  assert.deepEqual(await readBoundedJson(streamingRequest([encoder.encode('{"ok":true}')]), LIMIT), { ok: true })
})

test('malformed JSON and malformed UTF-8 fail safely', async () => {
  await assert.rejects(readBoundedJson(streamingRequest([encoder.encode('{bad')]), LIMIT), (error: unknown) =>
    error instanceof RequestBodyError && error.code === 'invalid_json')
  await assert.rejects(readBoundedText(streamingRequest([new Uint8Array([0xc3, 0x28])]), LIMIT), (error: unknown) =>
    error instanceof RequestBodyError && error.code === 'invalid_json')
})
