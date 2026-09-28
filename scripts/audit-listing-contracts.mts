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
    && Array.isArray((parsed as { listings?: unknown }).listings) ? (parsed as { listings: unknown[] }).listings
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { apis?: unknown }).apis)
      ? (parsed as { apis: Array<Record<string, unknown>> }).apis.map(api => {
        const request = api.request && typeof api.request === 'object' ? api.request as Record<string, unknown> : {}
        const body = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {}
        const dynamicPath = request.dynamic_path && typeof request.dynamic_path === 'object'
          ? request.dynamic_path as Record<string, unknown> : {}
        return {
          id: api.id,
          endpoint_url: 'https://read-only-audit.invalid/fixed',
          method: api.method,
          // Discovery intentionally hides credential configuration; this mode audits the buyer contract only.
          auth_type: 'public',
          example_request: api.example_request == null ? '' : JSON.stringify(api.example_request),
          body_required: body.required === true,
          dynamic_path_supported: dynamicPath.supported === true,
          path_parameters: request.path_parameters ?? [],
          query_parameters: request.query_parameters ?? [],
        }
      }) : null
  if (!rows) throw new Error('Expected a JSON array, { listings: [...] }, or public discovery { apis: [...] }')
  const report = auditListingContracts(rows)
  console.log(JSON.stringify({ checked: report.length, unsafe: report.filter(row => !row.safe).length, listings: report }, null, 2))
  if (report.some(row => !row.safe)) process.exitCode = 1
}
