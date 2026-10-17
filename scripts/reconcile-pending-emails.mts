/** Offline, read-only reconciliation. This program never connects to a database or imports rows. */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { getDomain } from 'tldts'
import { normalizeWorkerIdentity } from '../src/lib/admin-worker/normalization'

export const snapshotQuery = `BEGIN TRANSACTION READ ONLY;
SELECT jsonb_build_object(
 'observedAt',statement_timestamp(),
 'readOnly',current_setting('transaction_read_only'),
 'providers',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'domain',canonical_domain)),'[]') FROM public.worker_providers),
 'identities',(SELECT coalesce(jsonb_agg(jsonb_build_object('providerId',provider_id,'type',identity_type,'value',normalized_value)),'[]') FROM public.worker_provider_identities),
 'legacy',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',d.id,'url',d.repo_url,'invited',d.invited,
   'hasOutreachHistory',EXISTS(SELECT 1 FROM public.outreach_log o WHERE o.discovered_api_id=d.id))),'[]') FROM public.discovered_apis d),
 'reconciliation',(SELECT coalesce(jsonb_agg(row),'[]') FROM public.worker_providers p
   CROSS JOIN LATERAL jsonb_array_elements(public.mahshar_worker_mail_reconcile(p_dry_run=>true,p_provider_ids=>ARRAY[p.id])) row)
) AS snapshot;
ROLLBACK;`

export type MailSnapshot = {
  observedAt: string; readOnly: 'on'
  providers: Array<{ id: string; domain: string }>
  identities: Array<{ providerId: string; type: string; value: string }>
  legacy: Array<{ id: string; url: string; invited: boolean; hasOutreachHistory?: boolean }>
  reconciliation: Array<{ providerId: string; eligible: boolean; reason: string | null; registryStatus: string | null; selectedEmail?: string | null; qualificationStatus?: string | null }>
}

export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []; let row: string[] = []; let field = ''; let quoted = false
  const input = text.replace(/^\uFEFF/, '')
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (ch === '"') {
      if (quoted && input[i + 1] === '"') { field += '"'; i++ }
      else quoted = !quoted
    } else if (!quoted && (ch === ',' || ch === '\n')) {
      row.push(field.replace(/\r$/, '')); field = ''
      if (ch === '\n') { rows.push(row); row = [] }
    } else field += ch
  }
  if (quoted) throw new Error('Unterminated CSV field')
  if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row) }
  const headers = rows.shift()
  if (!headers || !['Company / Provider name', 'Official website', 'Verified business email'].every(k => headers.includes(k))) {
    throw new Error('Unexpected shortlist columns')
  }
  return rows.filter(r => r.some(Boolean)).map(r => {
    if (r.length !== headers.length) throw new Error('Unexpected CSV row width')
    return Object.fromEntries(headers.map((key, i) => [key, r[i]]))
  })
}

export function reconcileShortlist(csv: string, snapshot?: MailSnapshot) {
  if (snapshot && (snapshot.readOnly !== 'on' || !snapshot.observedAt || !Array.isArray(snapshot.reconciliation))) {
    throw new Error('A timestamped read-only database snapshot is required')
  }
  const rows = parseCsv(csv)
  const identities = new Map<string, Set<string>>()
  function add(domain: string, id: string) {
    const key = normalizeWorkerIdentity('domain', domain)
    const values = identities.get(key) ?? new Set<string>(); values.add(id); identities.set(key, values)
  }
  for (const p of snapshot?.providers ?? []) add(p.domain, p.id)
  for (const i of snapshot?.identities ?? []) if (i.type === 'domain') add(i.value, i.providerId)
  const seen = new Set<string>(); const emails = new Set<string>()
  const records = rows.map(row => {
    const identity = normalizeWorkerIdentity('domain', row['Official website'].replace('://www.', '://'))
    const email = row['Verified business email'].toLowerCase()
    if (seen.has(identity) || emails.has(email)) throw new Error('Duplicate shortlist identity or email')
    seen.add(identity); emails.add(email)
    const matches = [...(identities.get(identity) ?? [])]
    const legacy = (snapshot?.legacy ?? []).filter(item => {
      try {
        const legacyIdentity = normalizeWorkerIdentity('domain', item.url.replace('://www.', '://'))
        return legacyIdentity === identity || (getDomain(identity, { allowPrivateDomains: true }) === identity && legacyIdentity.endsWith('.' + identity))
      }
      catch { return false }
    })
    const result = matches.length === 1 ? snapshot?.reconciliation.find(r => r.providerId === matches[0]) : undefined
    const disposition = !snapshot ? 'database_snapshot_required' : matches.length > 1 ? 'identity_conflict'
      : result?.registryStatus === 'manual_sent' || result?.registryStatus === 'excluded' ? 'permanent_history'
        : legacy.some(r => r.invited || r.hasOutreachHistory) ? 'legacy_contacted'
          : result?.eligible ? result.registryStatus === 'pending' ? 'already_pending' : 'eligible'
            : result ? result.reason ?? 'ineligible' : legacy.length ? 'legacy_requires_worker_evidence' : 'identity_unresolved'
    const assessment = disposition === 'eligible' || disposition === 'already_pending' ? 'eligible'
      : disposition === 'legacy_requires_worker_evidence' ? 'legacy_first_pass'
        : disposition === 'identity_unresolved' || disposition === 'identity_conflict' ? 'identity_unresolved'
          : disposition === 'simulation_history' ? 'simulation_hold'
            : disposition === 'acquisition_in_progress' ? 'temporary_channel_hold'
            : disposition === 'qualification_or_contact_incomplete' ? result?.qualificationStatus === 'qualified'
              ? 'qualified_evidence_required' : 'qualification_incomplete'
              : disposition === 'database_snapshot_required' ? disposition
                : ['permanent_history','mail_history','legacy_contacted','provider_finalized','manual_contact_suppressed',
                  'legacy_outreach_history','outreach_history','acquisition_history'].includes(disposition) ? 'permanent_exclusion' : 'needs_review'
    return { assessment, qualificationStatus: result?.qualificationStatus ?? null, name: row['Company / Provider name'], identity, disposition,
      providerId: matches.length === 1 ? matches[0] : null, legacyIds: legacy.map(r => r.id),
      // The CSV address is evidence to reconcile, never an instruction to replace a verified contact.
      csvEmail: email, selectedEmail: result?.selectedEmail ?? null }
  })
  const csvSha256 = createHash('sha256').update(csv).digest('hex')
  const legacyIntake = records.filter(record => record.disposition === 'legacy_requires_worker_evidence').map(record => {
    const row = rows.find(row => normalizeWorkerIdentity('domain', row['Official website'].replace('://www.', '://')) === record.identity)!
    return { identity: record.identity, legacyIds: record.legacyIds, providerName: record.name,
      productName: row['API product name'], docsUrl: row['API documentation URL'], officialUrl: row['Official website'], csvSha256 }
  })
  return { dryRun: true, csvSha256,
    observedAt: snapshot?.observedAt ?? null, count: records.length,
    counts: records.reduce<Record<string, number>>((counts, row) => {
      counts[row.disposition] = (counts[row.disposition] ?? 0) + 1; return counts
    }, {}),
    assessments: records.reduce<Record<string, number>>((counts, record) => { counts[record.assessment] = (counts[record.assessment] ?? 0) + 1; return counts }, { eligible: 0, qualified_evidence_required: 0, qualification_incomplete: 0, legacy_first_pass: 0, identity_unresolved: 0, simulation_hold: 0, permanent_exclusion: 0 }),
    legacyIntake,
    eligibleProviderIds: records.filter(r => r.disposition === 'eligible').map(r => r.providerId), records }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  if (args.includes('--print-query')) process.stdout.write(snapshotQuery + '\n')
  else {
    const snapshotIndex = args.indexOf('--snapshot')
    const csvIndex = args.indexOf('--csv')
    const csvPath = csvIndex < 0 ? 'exports/mahshar-api-provider-shortlist-2026-10-16.csv' : args[csvIndex + 1]
    if (!csvPath || (snapshotIndex >= 0 && !args[snapshotIndex + 1]) || args.some(arg => arg.startsWith('--') && !['--csv','--snapshot'].includes(arg))) {
      throw new Error('Usage: reconcile-pending-emails.mts [--csv path] [--snapshot path] | --print-query')
    }
    const snapshot = snapshotIndex < 0 ? undefined : JSON.parse(readFileSync(args[snapshotIndex + 1], 'utf8')) as MailSnapshot
    process.stdout.write(JSON.stringify(reconcileShortlist(readFileSync(csvPath, 'utf8'), snapshot), null, 2) + '\n')
  }
}
