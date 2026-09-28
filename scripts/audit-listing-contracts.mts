import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { auditListingContracts } from '../src/lib/marketplace/listing-contract-audit'

const input = process.argv[2]
if (!input) {
  console.error('Usage: npx tsx scripts/audit-listing-contracts.mts <read-only-listing-export.json>')
  process.exitCode = 2
} else {
  const parsed = JSON.parse(await readFile(resolve(input), 'utf8')) as unknown
  const rows = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object'
    && Array.isArray((parsed as { listings?: unknown }).listings) ? (parsed as { listings: unknown[] }).listings : null
  if (!rows) throw new Error('Expected a JSON array or an object with a listings array')
  const report = auditListingContracts(rows)
  console.log(JSON.stringify({ checked: report.length, unsafe: report.filter(row => !row.safe).length, listings: report }, null, 2))
  if (report.some(row => !row.safe)) process.exitCode = 1
}
