import { validateDeclaredParameterMetadata } from './proxy-target'
import { validateListingRequestContract } from './request-contract'

export type ListingContractAuditRow = {
  id?: unknown
  dynamic_path_supported?: unknown
  path_parameters?: unknown
  query_parameters?: unknown
  endpoint_url?: unknown
  method?: unknown
  auth_type?: unknown
  auth_param_name?: unknown
  example_request?: unknown
  body_required?: unknown
}

export function auditListingContracts(rows: ListingContractAuditRow[]) {
  return rows.map((row, index) => {
    const id = typeof row.id === 'string' ? row.id : `row-${index + 1}`
    const issues: string[] = []
    if (typeof row.endpoint_url === 'string') {
      const contract = validateListingRequestContract(row as Parameters<typeof validateListingRequestContract>[0])
      if (!contract.ok) issues.push(`${contract.field}: ${contract.error}`)
      return { id, safe: issues.length === 0, issues }
    }
    if (row.path_parameters != null && !validateDeclaredParameterMetadata(row.path_parameters)) {
      issues.push('path_parameters is invalid or contains an unsafe pattern')
    }
    if (row.query_parameters != null && !validateDeclaredParameterMetadata(row.query_parameters)) {
      issues.push('query_parameters is invalid or contains an unsafe pattern')
    }
    if (row.dynamic_path_supported !== true) {
      if (row.dynamic_path_supported !== false && row.dynamic_path_supported != null) {
        issues.push('dynamic_path_supported must be boolean; runtime treats this listing as disabled')
      }
    } else {
      if (row.path_parameters == null || (Array.isArray(row.path_parameters) && row.path_parameters.length === 0)) {
        issues.push('dynamic paths are enabled without a usable declared path contract')
      }
    }
    return { id, safe: issues.length === 0, issues }
  })
}
