import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { sortQualifiedLeadRows, sortQualifiedLeadSources, workerRunDto } from '../../src/lib/admin-worker/repository'
import { verificationLabel, workerCompletionLabel } from '../../src/lib/admin-worker/presentation'

const read = (path: string) => readFileSync(path, 'utf8')
const migrationPath = 'supabase/migrations/20261001000100_admin_worker_foundation.sql'
const discoveryMigrationPath = 'supabase/migrations/20261002000100_admin_worker_discovery_v1.sql'
const reviewMigrationPath = 'supabase/migrations/20261004000100_admin_worker_discovery_review_candidates.sql'
const targetMigrationPath = 'supabase/migrations/20261005000100_admin_worker_qualified_target_traction.sql'
const retryMigrationPath = 'supabase/migrations/20261005000200_admin_worker_retry_idempotency.sql'
const contactMigrationPath = 'supabase/migrations/20261005000300_admin_worker_contact_discovery.sql'

test('Worker migration creates the bounded server-only schema and lifecycle RPCs', () => {
  const sql = read(migrationPath)
  for (const table of ['worker_control', 'worker_runs', 'worker_providers', 'worker_provider_identities',
    'worker_products', 'worker_leads', 'worker_sources', 'worker_decisions']) {
    assert.match(sql, new RegExp(`CREATE TABLE public\\.${table}`))
    assert.match(sql, new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`))
  }
  assert.match(sql, /DEFAULT 'stopped'/)
  assert.match(sql, /DEFAULT 50 CHECK \(batch_size BETWEEN 1 AND 100\)/)
  assert.match(sql, /worker_runs_one_active[\s\S]*WHERE status IN \('queued', 'running', 'stop_requested'\)/)
  assert.match(sql, /heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp\(\)/)
  assert.match(sql, /checkpoint_run_id uuid/)
  assert.match(sql, /worker_control_checkpoint_run_fk[\s\S]*REFERENCES public\.worker_runs\(id\)/)
  assert.match(sql, /REVOKE ALL ON public\.worker_control[\s\S]*FROM PUBLIC, anon, authenticated/)
  assert.match(sql, /REVOKE ALL ON SEQUENCE public\.worker_runs_run_number_seq FROM PUBLIC, anon, authenticated/)
  assert.match(sql, /GRANT USAGE ON SEQUENCE public\.worker_runs_run_number_seq TO service_role/)
  assert.doesNotMatch(sql, /GRANT (?:SELECT|UPDATE)[^;]*worker_runs_run_number_seq TO service_role/)
  for (const fn of ['reconcile_stale_run', 'create_run', 'request_stop', 'claim_run', 'advance_run', 'complete_run', 'fail_run', 'attach_workflow_run']) {
    assert.match(sql, new RegExp(`mahshar_worker_${fn}`))
  }
  assert.equal((sql.match(/SECURITY DEFINER\s+SET search_path = ''/g) ?? []).length, 8)
  assert.match(sql, /interval '15 minutes'/)
  assert.match(sql, /error_code = 'worker_run_stale'/)
  assert.match(sql, /source_run\.checkpoint <> checkpoint_value/)
  assert.match(sql, /decision IN \('approved', 'rejected', 'do_not_contact', 'reopened'\)/)
  assert.doesNotMatch(sql, /raw_html|screenshot|llm_prompt|llm_response/)
})

test('Admin Worker routes use the existing Admin boundary and expose only intended methods', () => {
  for (const action of ['start', 'stop', 'resume']) {
    const source = read(`src/app/api/admin/worker/${action}/route.ts`)
    assert.match(source, /withAdmin/)
    assert.match(source, /export const POST/)
    assert.doesNotMatch(source, /export const (?:GET|PUT|PATCH|DELETE)/)
  }
  for (const readRoute of ['status', 'runs', 'leads']) {
    const source = read(`src/app/api/admin/worker/${readRoute}/route.ts`)
    assert.match(source, /withAdmin/)
    assert.match(source, /export const GET/)
    assert.doesNotMatch(source, /export const (?:POST|PUT|PATCH|DELETE)/)
  }
  assert.equal(existsSync('src/app/api/worker'), false)
})

test('Worker DTO is an explicit allowlist and drops unrestricted database fields', () => {
  const dto = workerRunDto({
    id: '00000000-0000-4000-8000-000000000001', run_number: 1, status: 'running', batch_size: 50,
    processed_count: 10, discovered_count: 0, duplicate_count: 0, filtered_count: 0, qualified_count: 0,
    deferred_count: 0, review_candidate_count: 0, persisted_count: 0, traction_scored_count: 0,
    qualified_target: 50, raw_candidate_limit: null, source_cursor: null, source_exhausted: false,
    completion_reason: null, source_query_count: 0, research_fetch_count: 0, groq_call_count: 0, traction_fetch_count: 0,
    checkpoint: { version: 1, nextIndex: 10, batchSize: 50 }, workflow_run_id: 'wrun_fixture',
    error_code: null, started_at: '2026-10-01T00:00:00.000Z', stopped_at: null, completed_at: null,
    created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:01.000Z',
    raw_exception: 'never-return', credential: 'never-return', arbitrary_payload: { secret: 'never-return' },
  })
  const serialized = JSON.stringify(dto)
  assert.equal(serialized.includes('never-return'), false)
  assert.equal(dto.targets.raw_limit, 50)
  assert.equal(dto.source_cursor, 10)
  assert.deepEqual(Object.keys(dto).sort(), ['batch_size', 'checkpoint', 'completed_at', 'counts', 'created_at', 'error_code',
    'completion_reason', 'id', 'processed_count', 'resources', 'run_number', 'source_cursor', 'source_exhausted',
    'started_at', 'status', 'stopped_at', 'targets', 'updated_at', 'workflow_run_id'].sort())
})

test('qualified lead and provenance ordering is stable for identical timestamps', () => {
  const timestamp = '2026-10-03T12:00:00.000Z'
  assert.deepEqual(sortQualifiedLeadRows([
    { id: 'a', created_at: timestamp }, { id: 'c', created_at: timestamp }, { id: 'b', created_at: timestamp },
  ]).map(row => row.id), ['c', 'b', 'a'])
  assert.deepEqual(sortQualifiedLeadSources([
    { id: 'b', source_role: 'directory_assertion', created_at: timestamp, url: 'https://directory.example/b' },
    { id: 'c', source_role: 'official_docs', created_at: timestamp, url: 'https://docs.example/c' },
    { id: 'a', source_role: 'official_docs', created_at: timestamp, url: 'https://docs.example/a' },
  ]).map(row => row.id), ['c', 'a', 'b'])
  assert.deepEqual(sortQualifiedLeadRows([
    { id: 'review-high', qualification_status: 'review_candidate', fit_score: 69, traction_score: 100, traction_confidence: 'high', contactability_status: 'verified_official_contact', created_at: timestamp },
    { id: 'fit-80-low', qualification_status: 'qualified', fit_score: 80, traction_score: 10, traction_confidence: 'low', contactability_status: 'unknown', created_at: timestamp },
    { id: 'fit-80-high', qualification_status: 'qualified', fit_score: 80, traction_score: 90, traction_confidence: 'high', contactability_status: 'verified_official_contact', created_at: timestamp },
    { id: 'fit-70', qualification_status: 'qualified', fit_score: 70, traction_score: 100, traction_confidence: 'high', contactability_status: 'verified_official_contact', created_at: timestamp },
  ]).map(row => row.id), ['fit-80-high', 'fit-80-low', 'fit-70', 'review-high'])
  assert.deepEqual(sortQualifiedLeadRows([
    { id: 'unknown', qualification_status: 'qualified', fit_score: 80, traction_score: 50, traction_confidence: 'unknown', contactability_status: 'unknown', created_at: timestamp },
    { id: 'low', qualification_status: 'qualified', fit_score: 80, traction_score: 50, traction_confidence: 'low', contactability_status: 'unknown', created_at: timestamp },
    { id: 'contact', qualification_status: 'qualified', fit_score: 80, traction_score: 50, traction_confidence: 'high', contactability_status: 'verified_official_contact', created_at: timestamp },
    { id: 'newer', qualification_status: 'qualified', fit_score: 80, traction_score: 50, traction_confidence: 'high', contactability_status: 'unknown', created_at: '2026-10-03T13:00:00.000Z' },
    { id: 'stable-b', qualification_status: 'qualified', fit_score: 80, traction_score: 50, traction_confidence: 'high', contactability_status: 'unknown', created_at: timestamp },
    { id: 'stable-a', qualification_status: 'qualified', fit_score: 80, traction_score: 50, traction_confidence: 'high', contactability_status: 'unknown', created_at: timestamp },
  ]).map(row => row.id), ['contact', 'newer', 'stable-b', 'stable-a', 'low', 'unknown'])
})

test('Worker presentation is conservative for legacy completion and unverified evidence', () => {
  assert.equal(workerCompletionLabel({ status: 'completed', completion_reason: null }), 'Completed')
  assert.equal(workerCompletionLabel({ status: 'running', completion_reason: null }), 'In progress')
  assert.equal(workerCompletionLabel({ status: 'completed', completion_reason: 'source_exhausted' }), 'Source exhausted')
  assert.equal(verificationLabel(false), 'Not verified')
  assert.equal(verificationLabel(true), 'Verified')
})

test('Admin UI includes separate Worker navigation, controls, Discovery metrics, and qualified leads', () => {
  const shell = read('src/app/admin/operations/operations-shell.tsx')
  const client = read('src/app/admin/worker/worker-client.tsx')
  assert.match(shell, /href="\/admin\/worker"/)
  assert.match(shell, />Worker Agent</)
  assert.match(client, /Discovery V1/)
  assert.match(client, /Qualified & Review Candidates/)
  assert.match(client, /manual review 60–69/)
  assert.match(client, /Loading qualified leads…/)
  assert.match(client, /leadsPhase === 'loading'/)
  assert.match(client, /Qualified leads are temporarily unavailable/)
  for (const column of ['API / Provider', 'Category', 'Fit', 'Status', 'Contact', 'Email', 'Activity', 'Last Evidence', 'Details']) {
    assert.match(client, new RegExp(column.replace('/', '\\/')))
  }
  assert.doesNotMatch(client, /not found/i)
  assert.match(client, /not usage|activity estimate/i)
  assert.match(client, /AI qualification/)
  assert.match(client, /Technical evidence/)
  assert.match(client, /Traction signals/)
  assert.match(client, /Official route/)
  assert.match(client, /GitHub/)
  assert.match(client, /Pricing/)
  assert.match(client, /Auth/)
  assert.match(client, /Concerns/)
  assert.match(client, /Discovered/)
  assert.match(client, /aria-expanded/)
  assert.match(client, /no outreach, account creation, or Marketplace listing occurs/i)
  for (const action of ['Start', 'Stop', 'Resume']) assert.match(client, new RegExp(`'${action.toLowerCase()}'|>${action}<`))
  assert.match(client, /document\.visibilityState !== 'visible'/)
  assert.match(client, /12_000/)
  assert.match(client, /Showing the last known Worker state/)
  assert.doesNotMatch(client, /dangerouslySetInnerHTML/)
})

test('Admin lead query exposes only active review candidates and preserves later human status', () => {
  const repository = read('src/lib/admin-worker/repository.ts')
  assert.match(repository, /and\(status\.eq\.discovered,qualification_status\.in\.\(qualified,review_candidate\)\)/)
  assert.match(repository, /item\.status === 'discovered' && item\.qualification_status === 'review_candidate'/)
  assert.match(repository, /technical_qualified/)
  assert.match(repository, /worker_contacts/)
})

test('review-candidate migration adds the 60-69 band without weakening hard gates', () => {
  const sql = read(reviewMigrationPath)
  assert.match(sql, /qualification_status IN \('pending', 'qualified', 'review_candidate', 'rejected', 'deferred'\)/)
  assert.match(sql, /WHEN \(p_qualification->>'fitScore'\)::numeric >= 70 THEN 'qualified'/)
  assert.match(sql, /WHEN \(p_qualification->>'fitScore'\)::numeric >= 60 THEN 'review_candidate'/)
  assert.match(sql, /WHEN qualification_disposition = 'review_candidate' THEN 'discovered'/)
  assert.match(sql, /outcome_status := 'persisted'; outcome_reason := 'review_candidate'/)
  assert.match(sql, /existing_human_state/)
  assert.match(sql, /do_not_contact/)
  assert.match(sql, /SET search_path = ''/)
  assert.doesNotMatch(sql, /api_listings|purchases|api_calls|settlement|withdraw|gateway|wallet|seller_credentials/i)
})

test('Workflow remains bounded and compact while delegating isolated Discovery V1 work', () => {
  const workflow = read('src/workflows/admin-worker-batch.ts')
  const steps = read('src/lib/admin-worker/workflow-steps.ts')
  assert.match(workflow, /'use workflow'/)
  assert.match(steps, /'use step'/)
  assert.match(steps, /processDiscoveryRange/)
  assert.match(steps, /advanceWorkerDiscoveryRun/)
  assert.match(workflow, /WORKER_MAX_BATCH_SIZE \/ WORKER_CHUNK_SIZE/)
  assert.doesNotMatch(workflow + steps, /sendEmail|nodemailer|outreach|marketplace|gateway|settlement|withdraw/i)
  assert.doesNotMatch(read('src/lib/admin-worker/checkpoint.ts'), /items|candidate/)
})

test('Discovery migration adds durable work, bounded budgets, and server-only grants', () => {
  const sql = read(discoveryMigrationPath)
  assert.match(sql, /CREATE TABLE public\.worker_candidates/)
  assert.match(sql, /CREATE TABLE public\.worker_budget_claims/)
  assert.match(sql, /CREATE TABLE public\.worker_source_work/)
  assert.match(sql, /discovery_batch_id uuid NOT NULL REFERENCES public\.worker_runs/)
  assert.match(sql, /CHECK \(source_query_count BETWEEN 0 AND 60\)/)
  assert.match(sql, /CHECK \(research_fetch_count BETWEEN 0 AND 50\)/)
  assert.match(sql, /CHECK \(groq_call_count BETWEEN 0 AND 20\)/)
  assert.match(sql, /deadline_at timestamptz/)
  assert.match(sql, /retention_eligible_at timestamptz/)
  assert.match(sql, /worker_leads_product_unique UNIQUE \(product_id\)/)
  assert.match(sql, /mahshar_worker_claim_budget/)
  assert.match(sql, /mahshar_worker_materialize_source_work/)
  assert.match(sql, /mahshar_worker_claim_deferred_candidates/)
  assert.match(sql, /mahshar_worker_resolve_discovery_lead/)
  assert.match(sql, /mahshar_worker_advance_discovery_run/)
  assert.match(sql, /ALTER TABLE public\.worker_candidates ENABLE ROW LEVEL SECURITY/)
  assert.match(sql, /REVOKE ALL PRIVILEGES ON TABLE public\.worker_candidates[\s\S]*PUBLIC, anon, authenticated, service_role/)
  assert.match(sql, /control_row\.batch_size <> 50/)
  assert.doesNotMatch(sql, /raw_html|screenshot|llm_prompt|llm_response|groq_response/)
})

test('qualified-target migration is forward-only, bounded, Worker-only, and preserves historical migrations', () => {
  const sql = read(targetMigrationPath)
  assert.match(sql, /qualified_target integer NOT NULL DEFAULT 50 CHECK \(qualified_target = 50\)/)
  assert.match(sql, /raw_candidate_limit integer NOT NULL DEFAULT 300 CHECK \(raw_candidate_limit = 300\)/)
  assert.match(sql, /worker_candidates_ordinal_target_check CHECK \(ordinal BETWEEN 0 AND 299\)/)
  assert.match(sql, /source_query_count BETWEEN 0 AND 301/)
  assert.match(sql, /research_fetch_count BETWEEN 0 AND 240/)
  assert.match(sql, /groq_call_count BETWEEN 0 AND 100/)
  assert.match(sql, /traction_fetch_count BETWEEN 0 AND 60/)
  assert.match(sql, /'qualified_target_reached', 'source_exhausted', 'hard_limit_reached', 'deadline_reached'/)
  assert.match(sql, /mahshar_worker_create_target_run/)
  assert.match(sql, /mahshar_worker_advance_target_run/)
  assert.match(sql, /mahshar_worker_persist_qualification_v2/)
  assert.match(sql, /SECURITY DEFINER SET search_path = ''/)
  assert.match(sql, /REVOKE CREATE ON SCHEMA public/)
  assert.doesNotMatch(sql, /api_listings|purchases|api_calls|settlement|withdraw|gateway|wallet|seller_credentials/i)
})

test('retry-idempotency migration separates replay from exhaustion and recovers partial deferred leads', () => {
  const sql = read(retryMigrationPath)
  assert.match(sql, /mahshar_worker_claim_budget_v2/)
  assert.match(sql, /RETURNS text/)
  assert.match(sql, /RETURN 'claimed'/)
  assert.match(sql, /RETURN 'replayed'/)
  assert.match(sql, /RETURN 'exhausted'/)
  assert.match(sql, /RETURN 'deadline_reached'/)
  assert.match(sql, /lead\.status='discovered' AND lead\.qualification_status='pending'/)
  assert.match(sql, /'research_budget_exhausted','research_claim_replayed'/)
  assert.match(sql, /SECURITY DEFINER SET search_path = ''/)
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.mahshar_worker_claim_budget_v2[\s\S]*PUBLIC,anon,authenticated,service_role/)
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.mahshar_worker_claim_budget_v2[\s\S]*service_role/)
  assert.match(sql, /REVOKE CREATE ON SCHEMA public/)
  assert.doesNotMatch(sql, /api_listings|purchases|api_calls|settlement|withdraw|gateway|wallet|seller_credentials/i)
})

test('contact-discovery migration is bounded, retry-safe, actionable-only, and least-privilege', () => {
  const sql = read(contactMigrationPath)
  assert.match(sql, /CREATE TABLE public\.worker_contacts/)
  assert.match(sql, /CREATE TABLE public\.worker_contact_enrichment_claims/)
  assert.match(sql, /contact_fetch_count BETWEEN 0 AND 120/)
  assert.match(sql, /p_budget NOT IN \('source','research','groq','traction','contact'\)/)
  assert.match(sql, /THEN RETURN 'replayed'/)
  assert.match(sql, /contact_count<120/)
  assert.match(sql, /mahshar_worker_save_contact_research/)
  assert.match(sql, /mahshar_worker_claim_contact_enrichment/)
  assert.match(sql, /mahshar_worker_apply_contact_actionability/)
  assert.match(sql, /provider\.status IN \('do_not_contact','rejected'\) OR product\.status='rejected'/)
  assert.match(sql, /qualification_status IN \('qualified','review_candidate'\)/)
  assert.match(sql, /contactability_status IN \('verified_email','verified_official_contact','official_contact_page','official_sales_channel'\)/)
  assert.match(sql, /ALTER TABLE public\.worker_contacts ENABLE ROW LEVEL SECURITY/)
  assert.match(sql, /REVOKE ALL PRIVILEGES ON TABLE public\.worker_contacts FROM PUBLIC,anon,authenticated,service_role/)
  assert.match(sql, /SET search_path=''/)
  assert.doesNotMatch(sql, /api_listings|purchases|api_calls|settlement|withdraw|gateway|wallet|seller_credentials/i)
})

test('protected core source does not import the Admin Worker module', () => {
  const excluded = ['src/app/api/admin', 'src/app/admin', 'src/lib/admin-worker', 'src/workflows']
  const walk = (path: string): string[] => readdirSync(path).flatMap(name => {
    const child = join(path, name)
    if (excluded.some(prefix => child.startsWith(prefix))) return []
    return statSync(child).isDirectory() ? walk(child) : /\.(?:ts|tsx)$/.test(child) ? [child] : []
  })
  for (const file of [...walk('src/app'), ...walk('src/lib')]) {
    assert.doesNotMatch(read(file), /@\/lib\/admin-worker|workflows\/admin-worker/, file)
  }
})

test('Admin Worker dependency graph never resolves into Marketplace implementation code', () => {
  const queue = readdirSync('src/lib/admin-worker', { recursive: true })
    .filter(name => typeof name === 'string' && /\.(?:ts|tsx)$/.test(name))
    .map(name => join('src/lib/admin-worker', name as string))
  const visited = new Set<string>()
  while (queue.length) {
    const file = queue.pop()!
    if (visited.has(file) || !existsSync(file)) continue
    visited.add(file)
    assert.equal(file.includes('/marketplace/'), false, `Worker dependency reached ${file}`)
    const imports = [...read(file).matchAll(/(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g)]
      .map(match => match[1])
    for (const specifier of imports) {
      const base = specifier.startsWith('@/') ? join('src', specifier.slice(2))
        : specifier.startsWith('.') ? resolve(dirname(file), specifier) : null
      if (!base) continue
      for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
        if (existsSync(candidate)) queue.push(candidate.startsWith('/') ? candidate.slice(process.cwd().length + 1) : candidate)
      }
    }
  }
})
