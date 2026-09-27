const objectOrNull = (value: unknown) => value === null || (typeof value === 'object' && !Array.isArray(value))
const arrayOrNull = (value: unknown) => value === null || Array.isArray(value)

export function listingContractMetadata(body: Record<string, unknown>, method: string) {
  const patch: Record<string, unknown> = {}
  for (const key of ['request_schema', 'response_schema'] as const) {
    if (body[key] !== undefined) {
      if (!objectOrNull(body[key])) return { ok: false as const, error: `${key} must be a JSON object or null` }
      patch[key] = body[key]
    }
  }
  for (const key of ['path_parameters', 'query_parameters'] as const) {
    if (body[key] !== undefined) {
      if (!arrayOrNull(body[key])) return { ok: false as const, error: `${key} must be a JSON array or null` }
      patch[key] = body[key]
    }
  }
  if (body.body_required !== undefined) {
    if (body.body_required !== null && typeof body.body_required !== 'boolean') return { ok: false as const, error: 'body_required must be boolean or null' }
    if (method === 'GET' && body.body_required === true) return { ok: false as const, error: 'GET listings cannot require a body' }
    patch.body_required = body.body_required
  }
  if (body.dynamic_path_supported !== undefined) {
    if (typeof body.dynamic_path_supported !== 'boolean') return { ok: false as const, error: 'dynamic_path_supported must be boolean' }
    patch.dynamic_path_supported = body.dynamic_path_supported
  }
  return { ok: true as const, patch }
}
