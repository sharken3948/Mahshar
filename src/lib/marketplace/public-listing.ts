export const PUBLIC_LISTING_COLUMNS = [
  'id',
  'name',
  'description',
  'category',
  'price_per_call',
  'payment_model',
  'score',
  'uptime',
  'is_active',
  'seller_wallet',
  'auth_type',
  'method',
  'example_request',
  'example_response',
  'request_schema',
  'response_schema',
  'body_required',
  'dynamic_path_supported',
  'path_parameters',
  'query_parameters',
  'expected_status_codes',
  'verified_at',
  'created_at',
].join(', ')

/** Public marketplace responses must be built from an allowlist, never `select('*')`. */
export function publicListing<T extends Record<string, unknown>>(row: T) {
  const {
    id, name, description, category, price_per_call, payment_model, score, uptime,
    is_active, seller_wallet, auth_type, method, example_request, example_response,
    request_schema, response_schema, body_required, dynamic_path_supported, path_parameters, query_parameters,
    expected_status_codes, verified_at, created_at,
  } = row
  return {
    id, name, description, category, price_per_call, payment_model, score, uptime,
    is_active, seller_wallet, auth_type, method, example_request, example_response,
    request_schema, response_schema, body_required, dynamic_path_supported, path_parameters, query_parameters,
    expected_status_codes, verified_at, created_at,
  }
}
