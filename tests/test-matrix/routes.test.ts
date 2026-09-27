import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import * as publicGet from '../../src/app/api/test-matrix/public-get/[[...path]]/route'
import * as apiKeyPost from '../../src/app/api/test-matrix/api-key-post/route'
import * as bearerPut from '../../src/app/api/test-matrix/bearer-put/route'
import * as queryDelete from '../../src/app/api/test-matrix/query-delete/route'
import { respondForTestMatrixMode } from '../../src/lib/test-matrix/server'

const originalEnvironment = {
  enabled: process.env.ENABLE_TEST_MATRIX_ENDPOINTS,
  apiKey: process.env.TEST_MATRIX_API_KEY_POST_SECRET,
  bearer: process.env.TEST_MATRIX_BEARER_PUT_SECRET,
  query: process.env.TEST_MATRIX_QUERY_DELETE_SECRET,
}

const secrets = {
  apiKey: 'api-key-test-secret',
  bearer: 'bearer-test-secret',
  query: 'query-test-secret',
}

function enableRoutes() {
  process.env.ENABLE_TEST_MATRIX_ENDPOINTS = 'true'
  process.env.TEST_MATRIX_API_KEY_POST_SECRET = secrets.apiKey
  process.env.TEST_MATRIX_BEARER_PUT_SECRET = secrets.bearer
  process.env.TEST_MATRIX_QUERY_DELETE_SECRET = secrets.query
}

function request(path: string, method: string, options: { headers?: HeadersInit; body?: string } = {}) {
  return new Request(`https://mahshar.example${path}`, {
    method,
    headers: options.headers,
    body: options.body,
  })
}

before(enableRoutes)
after(() => {
  for (const [name, value] of Object.entries({
    ENABLE_TEST_MATRIX_ENDPOINTS: originalEnvironment.enabled,
    TEST_MATRIX_API_KEY_POST_SECRET: originalEnvironment.apiKey,
    TEST_MATRIX_BEARER_PUT_SECRET: originalEnvironment.bearer,
    TEST_MATRIX_QUERY_DELETE_SECRET: originalEnvironment.query,
  })) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

test('each route accepts only its configured method', async () => {
  const allowed = [
    await publicGet.GET(request('/api/test-matrix/public-get', 'GET')),
    await apiKeyPost.POST(request('/api/test-matrix/api-key-post', 'POST', {
      headers: { 'x-api-key': secrets.apiKey }, body: '{}',
    })),
    await bearerPut.PUT(request('/api/test-matrix/bearer-put', 'PUT', {
      headers: { authorization: `Bearer ${secrets.bearer}` }, body: '{}',
    })),
    await queryDelete.DELETE(request(`/api/test-matrix/query-delete?mahshar_key=${secrets.query}`, 'DELETE')),
  ]
  assert.deepEqual(allowed.map(response => response.status), [200, 200, 200, 200])

  const rejected = [
    await publicGet.POST(request('/api/test-matrix/public-get', 'POST')),
    await apiKeyPost.GET(request('/api/test-matrix/api-key-post', 'GET')),
    await bearerPut.POST(request('/api/test-matrix/bearer-put', 'POST')),
    await queryDelete.PUT(request('/api/test-matrix/query-delete', 'PUT')),
  ]
  assert.deepEqual(rejected.map(response => response.status), [405, 405, 405, 405])
  assert.deepEqual(rejected.map(response => response.headers.get('allow')), ['GET', 'POST', 'PUT', 'DELETE'])
})

test('public GET returns path, query, and only a boolean custom-header diagnostic', async () => {
  const response = await publicGet.GET(request(
    '/api/test-matrix/public-get/dynamic/segment?alpha=one&alpha=two',
    'GET',
    { headers: { 'x-mahshar-test-header': 'do-not-echo', authorization: 'do-not-echo' } },
  ))
  assert.equal(response.status, 200)
  const body = await response.json() as Record<string, unknown>
  assert.deepEqual(body, {
    ok: true,
    method: 'GET',
    path: '/api/test-matrix/public-get/dynamic/segment',
    query: { alpha: ['one', 'two'] },
    custom_header_received: true,
  })
  assert.doesNotMatch(JSON.stringify(body), /do-not-echo/)
})

test('API-key POST requires exact auth, parses JSON, and never echoes the key', async () => {
  const denied = await apiKeyPost.POST(request('/api/test-matrix/api-key-post', 'POST', {
    headers: { 'x-api-key': 'wrong' }, body: '{"value":1}',
  }))
  assert.equal(denied.status, 401)

  const response = await apiKeyPost.POST(request('/api/test-matrix/api-key-post', 'POST', {
    headers: { 'x-api-key': secrets.apiKey }, body: '{"value":1}',
  }))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.deepEqual(body, { ok: true, method: 'POST', auth: 'x-api-key', body: { value: 1 } })
  assert.doesNotMatch(JSON.stringify(body), new RegExp(secrets.apiKey))
})

test('bearer PUT requires an exact Bearer value and parses JSON', async () => {
  for (const authorization of [secrets.bearer, `bearer ${secrets.bearer}`, `Bearer ${secrets.bearer} extra`]) {
    const denied = await bearerPut.PUT(request('/api/test-matrix/bearer-put', 'PUT', {
      headers: { authorization }, body: '{}',
    }))
    assert.equal(denied.status, 401)
  }

  const response = await bearerPut.PUT(request('/api/test-matrix/bearer-put', 'PUT', {
    headers: { authorization: `Bearer ${secrets.bearer}` }, body: '{"value":2}',
  }))
  const body = await response.json()
  assert.deepEqual(body, { ok: true, method: 'PUT', auth: 'bearer', body: { value: 2 } })
  assert.doesNotMatch(JSON.stringify(body), new RegExp(secrets.bearer))
})

test('query DELETE preserves fixed query data, hides its secret, and supports optional JSON bodies', async () => {
  const base = `/api/test-matrix/query-delete?fixed=keep&mahshar_key=${secrets.query}`
  assert.equal((await queryDelete.DELETE(request(
    '/api/test-matrix/query-delete?fixed=keep&mahshar_key=wrong', 'DELETE',
  ))).status, 401)

  const withoutBody = await queryDelete.DELETE(request(base, 'DELETE'))
  assert.deepEqual(await withoutBody.json(), {
    ok: true, method: 'DELETE', auth: 'queryparam', fixed: 'keep', body_present: false, body: null,
  })

  const withBody = await queryDelete.DELETE(request(base, 'DELETE', { body: '{"value":3}' }))
  const responseBody = await withBody.json()
  assert.deepEqual(responseBody, {
    ok: true, method: 'DELETE', auth: 'queryparam', fixed: 'keep', body_present: true, body: { value: 3 },
  })
  assert.doesNotMatch(JSON.stringify(responseBody), new RegExp(secrets.query))
})

test('required and optional JSON bodies reject malformed input', async () => {
  assert.equal((await apiKeyPost.POST(request('/api/test-matrix/api-key-post', 'POST', {
    headers: { 'x-api-key': secrets.apiKey }, body: '{',
  }))).status, 400)
  assert.equal((await bearerPut.PUT(request('/api/test-matrix/bearer-put', 'PUT', {
    headers: { authorization: `Bearer ${secrets.bearer}` }, body: '',
  }))).status, 400)
  assert.equal((await queryDelete.DELETE(request(
    `/api/test-matrix/query-delete?mahshar_key=${secrets.query}`, 'DELETE', { body: '{' },
  ))).status, 400)
})

test('controlled response modes preserve exact status and content type', async () => {
  const text = await publicGet.GET(request('/api/test-matrix/public-get?mode=text', 'GET'))
  assert.equal(text.status, 200)
  assert.match(text.headers.get('content-type') ?? '', /^text\/plain/)
  assert.equal(await text.text(), 'test-matrix-ok')

  const invalid = await publicGet.GET(request('/api/test-matrix/public-get?mode=invalid-json', 'GET'))
  assert.equal(invalid.status, 200)
  assert.match(invalid.headers.get('content-type') ?? '', /^application\/json/)
  assert.equal(await invalid.text(), '{"ok":')

  assert.equal((await publicGet.GET(request('/api/test-matrix/public-get?mode=client-error', 'GET'))).status, 400)
  assert.equal((await publicGet.GET(request('/api/test-matrix/public-get?mode=server-error', 'GET'))).status, 500)

  const redirect = await publicGet.GET(request('/api/test-matrix/public-get?mode=redirect', 'GET'))
  assert.equal(redirect.status, 307)
  assert.equal(redirect.headers.get('location'), '/api/test-matrix/public-get?redirected=1')

  const started = Date.now()
  const slow = await respondForTestMatrixMode(
    request('/api/test-matrix/public-get?mode=slow', 'GET'),
    { ok: true },
    { slowDelayMs: 5 },
  )
  assert.equal(slow.status, 200)
  assert.ok(Date.now() - started >= 4)
  assert.deepEqual(await slow.json(), { ok: true })
})

test('disabled gate returns 404 before method or authentication details', async () => {
  process.env.ENABLE_TEST_MATRIX_ENDPOINTS = 'false'
  try {
    const responses = [
      await publicGet.POST(request('/api/test-matrix/public-get', 'POST')),
      await apiKeyPost.POST(request('/api/test-matrix/api-key-post', 'POST', { body: '{}' })),
      await bearerPut.PUT(request('/api/test-matrix/bearer-put', 'PUT', { body: '{}' })),
      await queryDelete.DELETE(request('/api/test-matrix/query-delete', 'DELETE')),
    ]
    assert.deepEqual(responses.map(response => response.status), [404, 404, 404, 404])
  } finally {
    process.env.ENABLE_TEST_MATRIX_ENDPOINTS = 'true'
  }
})

test('enabled protected routes fail closed when their server secret is not configured', async () => {
  delete process.env.TEST_MATRIX_API_KEY_POST_SECRET
  try {
    const response = await apiKeyPost.POST(request('/api/test-matrix/api-key-post', 'POST', {
      headers: { 'x-api-key': secrets.apiKey }, body: '{}',
    }))
    assert.equal(response.status, 503)
  } finally {
    process.env.TEST_MATRIX_API_KEY_POST_SECRET = secrets.apiKey
  }
})
