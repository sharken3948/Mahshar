import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

test('delivery migration fences historical attempts and uses service-only atomic claims', () => {
  const sql = readFileSync('supabase/migrations/20260926000200_x402_delivery_state.sql', 'utf8')
  assert.match(sql, /delivery_state text NOT NULL DEFAULT 'UNKNOWN'/)
  assert.match(sql, /ALTER COLUMN delivery_state SET DEFAULT 'NOT_STARTED'/)
  assert.match(sql, /delivery_state='IN_PROGRESS'/)
  assert.match(sql, /delivery_started_at < now\(\)-interval '2 minutes'/)
  assert.match(sql, /SET delivery_state='UNKNOWN'/)
  assert.match(sql, /delivery_request_hash <> p_request_hash/)
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.x402_delivery_claim/)
  assert.match(sql, /GRANT EXECUTE[\s\S]+TO service_role/)
})
