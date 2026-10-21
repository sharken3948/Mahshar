export const state = { calls: [] as Array<{ name: string; args: Record<string, unknown> }>, allowed: true,
  failure: false, releases: 0 }
export function createServiceClient() {
  return { rpc: async (name: string, args: Record<string, unknown>) => {
    state.calls.push({ name, args })
    if (state.failure) return { data: null, error: new Error('offline database failure') }
    if (name === 'mahshar_release_resource') { state.releases++; return { data: null, error: null } }
    return { data: [{ allowed: state.allowed, lease_id: args.p_lease_scope ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' : null,
      retry_after_seconds: 60 }], error: null }
  } }
}
