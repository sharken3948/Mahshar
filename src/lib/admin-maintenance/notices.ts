import 'server-only'
import { getAdvisoryScope } from './inventory'
import type { MaintenanceCheckResult, MaintenanceInventoryItem } from './types'

// All URLs are fixed official endpoints. Remote text is displayed as text only;
// it never supplies fetch targets, commands, or application configuration.
export type MaintenanceSources = {
  json: (url: string, init?: RequestInit) => Promise<unknown>
  text: (url: string, contentTypes: string[]) => Promise<string>
}

const MAX_ADVISORY_FINDINGS = 20

function review(item: MaintenanceInventoryItem, checkedAt: string): MaintenanceCheckResult {
  return { ...item, latest: null, status: 'unknown', severity: 'Review', action: 'review', deadline: null,
    impact: 'Needs review: compatibility with the installed implementation has not been established.',
    details: 'This manual check reads an official announcement; it does not validate runtime behavior.',
    recommended_action: 'Compare the official change with Mahshar’s implementation before deciding whether a change is necessary.', checked_at: checkedAt }
}

function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
}

export async function checkProtocolNotice(item: MaintenanceInventoryItem, sources: MaintenanceSources, checkedAt: string): Promise<MaintenanceCheckResult> {
  const result = review(item, checkedAt)
  if (item.id === 'cctp-notices') {
    const document = await sources.text('https://developers.circle.com/cctp/migration-from-v1-to-v2.md', ['text/markdown', 'text/plain'])
    const text = document.replace(/\s+/g, ' ')
    const date = '(January|February|March|April|May|June|July|August|September|October|November|December) \\d{1,2}, \\d{4}'
    const match = text.match(new RegExp(`CCTP V1 \\(Legacy\\) deprecation begins (${date}) and completes on (${date})\\b`))
    if (!match) throw new Error('cctp_notice_format_changed')
    const deadline = new Date(`${match[3]} UTC`).toISOString().slice(0, 10)
    return { ...result, latest: `CCTP V1 phase-out: ${match[1]} – ${match[3]}`, deadline,
      status: 'deprecation_notice', severity: 'Important',
      impact: 'Needs review: Circle is retiring CCTP V1. This notice alone does not establish that a Mahshar route uses V1.',
      details: `Official phase-out completion: ${deadline}.${deadline < checkedAt.slice(0, 10) ? ' The published deadline has passed.' : ''} Package names and versions are not proof of V2 compatibility.`,
      recommended_action: 'Verify active routes, deployed contract addresses, attestation APIs, and pending-transfer recovery against the official migration guide. Change only confirmed V1 dependencies.' }
  }
  if (item.id === 'mcp-protocol') {
    const data = await sources.json('https://api.github.com/repos/modelcontextprotocol/modelcontextprotocol/releases/latest') as { tag_name?: unknown }
    if (typeof data?.tag_name !== 'string' || !validDate(data.tag_name)) throw new Error('mcp_release_invalid')
    return { ...result, latest: `Protocol ${data.tag_name}`, source_url: `https://github.com/modelcontextprotocol/modelcontextprotocol/releases/tag/${data.tag_name}`,
      details: 'The latest official protocol release is compared with the displayed installed SDK, not assumed to match its supported wire versions. No compatibility baseline is recorded.',
      recommended_action: 'Review release changes against installed MCP protocol negotiation, transports, and tool schemas. A newer protocol does not automatically require an SDK upgrade.' }
  }
  const data = await sources.json('https://api.github.com/repos/ethereum/ERCs/commits?path=ERCS/erc-8004.md&per_page=1') as Array<{ sha?: unknown; commit?: { message?: unknown; committer?: { date?: unknown } } }>
  const revision = Array.isArray(data) && data.length === 1 ? data[0] : null
  const sha = revision?.sha
  const date = revision?.commit?.committer?.date
  if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha) || typeof date !== 'string' || !validDate(date.slice(0, 10))) throw new Error('erc_revision_invalid')
  const title = typeof revision?.commit?.message === 'string' ? revision.commit.message.split('\n')[0].replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200) : 'Specification revision'
  return { ...result, latest: `${date.slice(0, 10)} · ${sha.slice(0, 7)}`, source_url: `https://github.com/ethereum/ERCs/commit/${sha}`,
    details: `${title}. There is no pinned specification revision to establish whether this change is already covered by Mahshar.`,
    recommended_action: 'Review the official ERC-8004 revision against the existing identity registry reader and deployed registry interface. Do not change registry configuration based on a specification update alone.' }
}

export async function checkSecurityAdvisories(item: MaintenanceInventoryItem, sources: MaintenanceSources, checkedAt: string): Promise<MaintenanceCheckResult[]> {
  const scope = getAdvisoryScope()
  if (!scope.packages.length) throw new Error('advisory_inventory_empty')
  const data = await sources.json('https://api.osv.dev/v1/querybatch', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ queries: scope.packages.map(({ name, version }) => ({ package: { ecosystem: 'npm', name }, version })) }),
  }) as { results?: unknown[] }
  if (!Array.isArray(data?.results) || data.results.length !== scope.packages.length) throw new Error('advisory_response_invalid')
  const findings: MaintenanceCheckResult[] = []
  let complete = scope.complete
  let matches = 0
  for (const [index, value] of data.results.entries()) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('advisory_result_invalid')
    const row = value as { vulns?: unknown; next_page_token?: unknown }
    if (row.next_page_token) complete = false // No unbounded pagination.
    if (row.vulns === undefined) continue
    if (!Array.isArray(row.vulns)) throw new Error('advisory_vulns_invalid')
    const { name, version } = scope.packages[index]
    const ids = new Set<string>()
    for (const vuln of row.vulns) {
      const id = vuln && typeof vuln === 'object' ? (vuln as { id?: unknown }).id : null
      if (typeof id !== 'string' || !/^[A-Z][A-Za-z0-9._-]{1,100}$/.test(id)) throw new Error('advisory_id_invalid')
      ids.add(id)
    }
    for (const id of ids) {
      matches += 1
      if (findings.length >= MAX_ADVISORY_FINDINGS) { complete = false; continue }
      findings.push({ ...review(item, checkedAt), id: `advisory:${name}@${version}:${id}`, component: `${name} security advisory`, current: version,
        latest: id, status: 'action_required', severity: 'Important', action: 'required',
        source_url: /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/.test(id) ? `https://github.com/advisories/${id}` : `https://osv.dev/vulnerability/${id}`,
        impact: 'Action required: review an advisory matching this installed package version. Runtime exploitability has not been established.',
        details: `OSV returned ${id} for ${name}@${version}. This is an exact-version advisory lookup, not an assessment of reachable application code.`,
        recommended_action: 'Read the advisory’s affected conditions and fixed versions, assess Mahshar exposure, and test any necessary correction separately. No update was applied.' })
    }
  }
  return [{ ...review(item, checkedAt), latest: `${matches} advisory match(es); ${scope.packages.length} package versions checked`,
    status: !complete ? 'unknown' : matches ? 'action_required' : 'current', severity: matches ? 'Important' : !complete ? 'Review' : 'Info',
    action: matches ? 'required' : 'review',
    impact: !complete ? 'Needs review: advisory coverage is incomplete or the bounded result limit was reached.' : matches ? 'Action required: review the exact-version advisory findings below.' : 'No advisories returned in the checked scope. This is not a security or compatibility guarantee.',
    details: `${item.usage} At most 128 package versions and 20 findings are checked/displayed; no additional pages are fetched.`,
    recommended_action: !complete ? 'Review the official advisory database manually for omitted results or retry unavailable inventory.' : matches ? 'Review each matching advisory before choosing a correction.' : 'Continue manual monitoring; unreported vulnerabilities and unmonitored transitive dependencies are not ruled out.',
  }, ...findings]
}
