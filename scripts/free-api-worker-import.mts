/** Offline inventory → existing Worker store. No discovery, API tests or publication. */
import { isDeepStrictEqual } from 'node:util'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import { DatabaseStore } from '../src/lib/free-api-worker/store'
import { digest, usableCandidates, type Candidate } from '../src/lib/free-api-worker/model'

export async function loadInventory(directory = 'isolated-validation/free-api-worker-replacement/inventory-completion') {
  const read = (name: string) => readFile(resolve(directory, name), 'utf8')
  const [canonicalText, originalText, readyText, aliasesText, checksText] = await Promise.all(
    ['admin-evaluation.json', 'all-candidates.json', 'listed-candidates.json', 'merged-aliases.json', 'final-checks.json'].map(read))
  const canonical = JSON.parse(canonicalText).rows as Candidate[]
  const original = JSON.parse(originalText) as Candidate[]
  const ready = JSON.parse(readyText) as Candidate[]
  const aliases = JSON.parse(aliasesText) as Array<{ id: string; representative: string }>
  const checks = JSON.parse(checksText) as Array<{ id: string }>
  const byId = new Map(original.map(row => [row.lead.id, row]))
  const listedIds = usableCandidates(canonical).map(row => row.lead.id).sort()
  if (original.length !== 3633 || canonical.length !== 3619 || ready.length !== 656
    || JSON.stringify(listedIds) !== JSON.stringify(ready.map(row => row.lead.id).sort())
    || new Set(canonical.map(row => row.lead.id)).size !== canonical.length) throw new Error('Inventory manifest mismatch')
  for (const row of ready) {
    const saved = canonical.find(candidate => candidate.lead.id === row.lead.id)
    if (JSON.stringify(saved?.result) !== JSON.stringify(row.result)) throw new Error('Ready evidence mismatch')
  }
  const rows = canonical.map(row => ({ ...row, savedInventory: {
    original: byId.get(row.lead.id), checks: checks.find(check => check.id === row.lead.id),
    aliases: aliases.filter(alias => alias.representative === row.lead.id).map(alias => byId.get(alias.id)),
  } }))
  return { rows, inventory: { sourceCount: original.length, canonicalCount: rows.length, readyCount: ready.length,
    sha256: digest(canonicalText + originalText + readyText + aliasesText + checksText) } }
}
export async function importInventory(store: DatabaseStore, directory?: string) {
  const { rows, inventory } = await loadInventory(directory)
  // Atomic batches are idempotent: interrupted imports can be rerun without overwriting evidence.
  for (let offset = 0; offset < rows.length; offset += 50) await store.importInventory(rows.slice(offset, offset + 50), inventory)
  const stored = await store.candidates()
  const ids = new Set(rows.map(row => row.lead.id))
  if (stored.filter(row => ids.has(row.lead.id)).length !== rows.length) throw new Error('Incomplete inventory import')
  return { ...inventory, ready: usableCandidates(stored).length }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const url = new URL(process.env.FREE_WORKER_LOCAL_SUPABASE_URL ?? 'http://invalid')
  const key = process.env.FREE_WORKER_LOCAL_SERVICE_KEY
  if (process.argv[2] !== '--local' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' || !key) {
    throw new Error('Use --local with FREE_WORKER_LOCAL_SUPABASE_URL and FREE_WORKER_LOCAL_SERVICE_KEY for an isolated local database only. No .env files are loaded.')
  }
  const db = createClient(url.href, key, { auth: { persistSession: false, autoRefreshToken: false } })
  console.log(JSON.stringify(await importInventory(new DatabaseStore(db)), null, 2))
}

/** Final evaluated snapshot: retain excluded identities so Start never rediscovers them. */
export async function loadReleaseInventory(base: string) {
  const phase1 = await loadInventory(resolve(base, 'inventory-completion'))
  const evaluationText = await readFile(resolve(base, 'discovery-phase2/evaluation.json'), 'utf8')
  const readyText = await readFile(resolve(base, 'discovery-phase2/listed-candidates.json'), 'utf8')
  const saved = JSON.parse(evaluationText).rows as Candidate[]
  const ready = JSON.parse(readyText) as Candidate[]
  const expected = '7bfb9fd243e50fff62145d496aac5c10dc73648e04a8166f998a39e06853dca2'
  const ids = (rows: Candidate[]) => rows.map(row => row.lead.id).sort()
  if (saved.length !== 3925 || ready.length !== 672 || digest(readyText) !== expected
    || new Set(ids(saved)).size !== saved.length || JSON.stringify(ids(usableCandidates(saved))) !== JSON.stringify(ids(ready))) {
    throw new Error('Release inventory or Ready manifest mismatch')
  }
  const historical = new Map(phase1.rows.map(row => [row.lead.id, row.savedInventory]))
  const rows = saved.map(row => ({ ...row, savedInventory: historical.get(row.lead.id) ?? { checkpoint: row } }))
  return { rows, ready, inventory: { sourceCount: 3633, canonicalCount: saved.length, readyCount: ready.length,
    sha256: digest(evaluationText + readyText) } }
}

export async function importReleaseInventory(store: DatabaseStore, base: string) {
  const { rows, ready, inventory } = await loadReleaseInventory(base)
  if ((await store.state()).status !== 'stopped') throw new Error('Worker must remain stopped during release import')
  for (let offset = 0; offset < rows.length; offset += 50) await store.importInventory(rows.slice(offset, offset + 50), inventory)
  const stored = await store.candidates(), byId = new Map(stored.map(row => [row.lead.id, row]))
  const conflicts = rows.flatMap(row => {
    const found = byId.get(row.lead.id)
    return !found || !isDeepStrictEqual(found.lead, row.lead) || !isDeepStrictEqual(found.result, row.result)
      || found.removedAt || found.publishedAt ? [row.lead.id] : []
  })
  const actual = usableCandidates(stored).map(row => row.lead.id).sort()
  const expected = ready.map(row => row.lead.id).sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Ready count/identity conflict; no existing records were overwritten')
  if ((await store.state()).status !== 'stopped') throw new Error('Unexpected Worker state after import')
  return { inventory: rows.length, ready: actual.length, conflicts }
}
