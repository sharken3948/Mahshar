import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { databaseStore } from '../../src/lib/free-api-worker/runtime'
import { usableCandidates } from '../../src/lib/free-api-worker/model'
import { sql } from './postgres-adapter'

async function main() {
  const { importReleaseInventory, loadReleaseInventory } = await import('../../scripts/free-api-worker-import.mjs')
  const store = await databaseStore(), base=resolve('isolated-validation/free-api-worker-replacement')
  const before=sql("SELECT md5(row_to_json(t)::text) FROM public.api_listings t")
  const first=await importReleaseInventory(store,base)
  assert.equal(first.ready,672);assert.equal(first.inventory,3925);assert.deepEqual(first.conflicts,[])
  const hash=sql("SELECT md5(jsonb_agg(to_jsonb(t) ORDER BY id)::text) FROM public.free_worker_apis t")
  const again=await importReleaseInventory(store,base)
  assert.deepEqual(again,first)
  assert.equal(sql("SELECT md5(jsonb_agg(to_jsonb(t) ORDER BY id)::text) FROM public.free_worker_apis t"),hash)
  assert.equal(sql("SELECT md5(row_to_json(t)::text) FROM public.api_listings t"),before)
  assert.equal((await store.state()).status,'stopped')
  const {rows}=await loadReleaseInventory(base)
  await store.admit(rows.map(row=>row.lead))
  assert.equal((await store.candidates()).length,3925)
  assert.equal(usableCandidates(await store.candidates()).length,672)
  console.log('PASS release import: 3925 retained identities, 672 Ready, zero conflicts, idempotent reimport, stopped state, no Marketplace changes')
}
main().catch(error=>{console.error(error);process.exitCode=1})
