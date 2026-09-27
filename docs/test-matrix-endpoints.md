# Internal listing test matrix endpoints

These deterministic, read-only endpoints exist only to validate Mahshar listing
methods, upstream authentication, body forwarding, path/query handling, and
response handling. They do not call payment, wallet, database, or marketplace
code.

All endpoints return `404` unless this server-only environment variable is set:

```dotenv
ENABLE_TEST_MATRIX_ENDPOINTS=true
```

The protected routes additionally require distinct server-only secrets:

```dotenv
TEST_MATRIX_API_KEY_POST_SECRET=replace-with-a-random-api-key-secret
TEST_MATRIX_BEARER_PUT_SECRET=replace-with-a-random-bearer-secret
TEST_MATRIX_QUERY_DELETE_SECRET=replace-with-a-random-query-secret
```

Do not prefix these names with `NEXT_PUBLIC_`.

| Route | Method | Listing auth configuration |
| --- | --- | --- |
| `/api/test-matrix/public-get` | GET | `public` |
| `/api/test-matrix/api-key-post` | POST | `apikey` using `TEST_MATRIX_API_KEY_POST_SECRET` |
| `/api/test-matrix/bearer-put` | PUT | `bearer` using `TEST_MATRIX_BEARER_PUT_SECRET` |
| `/api/test-matrix/query-delete?fixed=keep` | DELETE | `queryparam`, parameter name `mahshar_key`, using `TEST_MATRIX_QUERY_DELETE_SECRET` |

The GET endpoint also accepts suffixes such as
`/api/test-matrix/public-get/dynamic/segment`. The DELETE endpoint accepts no
body or a JSON body. POST and PUT require valid JSON bodies.

Every route supports `mode=text`, `mode=invalid-json`, `mode=client-error`,
`mode=server-error`, `mode=redirect`, and `mode=slow`. The slow mode waits 10.5
seconds, just beyond Mahshar's current 10-second upstream timeout. The redirect
is a 307 to the same-app public GET endpoint. Secrets are never included in a
response or log.
