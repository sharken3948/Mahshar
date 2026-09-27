import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildUpstreamFailureDiagnostic,
  fetchUpstreamWithoutRedirects,
  MAX_UPSTREAM_DIAGNOSTIC_BODY_CHARS,
  readResponseBytes,
  ResponseTooLargeError,
} from './proxy-response';

test('upstream fetch forces manual redirect handling', async () => {
  let redirectMode: RequestRedirect | undefined;
  const response = await fetchUpstreamWithoutRedirects('https://seller.example/', {}, {
    resolver: async () => [{ address: '93.184.216.34', family: 4 }],
    requester: async (_url, _address, init) => {
      redirectMode = init.redirect;
      return new Response(null, { status: 302, headers: { location: 'https://other.example/' } });
    },
  });
  assert.equal(response.status, 302);
  assert.equal(redirectMode, 'manual');
});

test('response bytes remain intact below the configured cap', async () => {
  const response = new Response(new Uint8Array([1, 2, 3]));
  assert.deepEqual(await readResponseBytes(response.body, 3), new Uint8Array([1, 2, 3]));
});

test('oversized streaming response is cancelled as soon as bytes exceed the cap', async () => {
  let pulls = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      controller.enqueue(new Uint8Array(pulls === 1 ? 3 : pulls === 2 ? 2 : 1));
    },
    cancel() {
      cancelled = true;
    },
  }, { highWaterMark: 0 });

  await assert.rejects(readResponseBytes(stream, 4), ResponseTooLargeError);
  assert.equal(cancelled, true);
  assert.equal(pulls, 2);
});

test('upstream failure diagnostics preserve source metadata and safely truncate the raw body', () => {
  const rawBody = '<html>' + 'x'.repeat(MAX_UPSTREAM_DIAGNOSTIC_BODY_CHARS) + '</html>';
  const diagnostic = buildUpstreamFailureDiagnostic(404, 'text/html; charset=utf-8', rawBody);

  assert.equal(diagnostic.upstream_status, 404);
  assert.equal(diagnostic.upstream_content_type, 'text/html; charset=utf-8');
  assert.equal(diagnostic.upstream_body, rawBody.slice(0, MAX_UPSTREAM_DIAGNOSTIC_BODY_CHARS));
  assert.equal(diagnostic.upstream_body_truncated, true);
});

test('upstream failure diagnostics retain an unparsed short response body', () => {
  const rawBody = '{"error":"route not found"}';
  assert.deepEqual(buildUpstreamFailureDiagnostic(404, 'application/json', rawBody), {
    upstream_status: 404,
    upstream_content_type: 'application/json',
    upstream_body: rawBody,
    upstream_body_truncated: false,
  });
});
