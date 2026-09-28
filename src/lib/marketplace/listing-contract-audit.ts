import { validateDeclaredParameterMetadata } from './proxy-target'

export type ListingContractAuditRow = {
  id?: unknown
  dynamic_path_supported?: unknown
  path_parameters?: unknown
  query_parameters?: unknown
}

export function auditListingContracts(rows: ListingContractAuditRow[]) {
  return rows.map((row, index) => {
    const id = typeof row.id === 'string' ? row.id : `row-${index + 1}`
    const issues: string[] = []
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
      if ((row.path_parameters == null || (Array.isArray(row.path_parameters) && row.path_parameters.length === 0))
        && (row.query_parameters == null || (Array.isArray(row.query_parameters) && row.query_parameters.length === 0))) {
        issues.push('dynamic paths are enabled without a usable declared path/query contract')
      }
    }
    return { id, safe: issues.length === 0, issues }
  })
}
