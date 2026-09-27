import { listingProxyEntry } from './proxy-entry'

export type AgentListingRow = {
  id: string
  method: string
  example_request?: string | null
  example_response?: string | null
  request_schema?: Record<string, unknown> | null
  response_schema?: Record<string, unknown> | null
  body_required?: boolean | null
  dynamic_path_supported?: boolean | null
  path_parameters?: unknown[] | null
  query_parameters?: unknown[] | null
}

function parsedExample(value?: string | null): unknown {
  if (!value) return null
  try { return JSON.parse(value) } catch { return value }
}

export function agentExecutionContract(row: AgentListingRow, appUrl = 'https://mahshar.xyz') {
  const method = row.method.toUpperCase()
  const bodySupported = method !== 'GET'
  const dynamicPath = row.dynamic_path_supported === true
  const entry = listingProxyEntry(row.id, method, appUrl, dynamicPath)
  return {
    method: entry.method,
    proxy_url: entry.proxy_url,
    proxy_style: entry.proxy_style,
    request: {
      outer_method: entry.proxy_style === 'envelope' ? 'POST' : entry.method,
      content_type: bodySupported ? 'application/json' : null,
      body: {
        supported: bodySupported,
        required: bodySupported ? (row.body_required ?? null) : false,
        schema: row.request_schema ?? null,
        example: parsedExample(row.example_request),
        delete_body_supported: method === 'DELETE',
      },
      dynamic_path: {
        supported: dynamicPath,
        transport: dynamicPath ? 'envelope.path' : null,
      },
      path_parameters: row.path_parameters ?? [],
      query_parameters: row.query_parameters ?? [],
      incoming_headers: { supported: false, reason: 'Buyer-supplied headers are not forwarded upstream.' },
    },
    response: {
      content_type: 'application/json',
      schema: row.response_schema ?? null,
      example: parsedExample(row.example_response),
      wrapper: {
        response: 'Upstream JSON value or text string.',
        latency_ms: 'number',
        payment: 'ACCOUNTING_COMPLETE',
        delivery_state: 'SUCCEEDED | FAILED_RETRYABLE | FAILED_FINAL | UNKNOWN',
        attemptId: 'string',
        purchase_access_token: 'string',
      },
    },
  }
}
