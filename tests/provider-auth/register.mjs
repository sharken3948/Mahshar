import '../marketplace/register.mjs'
import Module from 'node:module'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const load = Module._load
const fixture = load.call(Module, fileURLToPath(new URL('../marketplace/fixtures.ts', import.meta.url)))
const outbound = load.call(Module, fileURLToPath(new URL('../../src/lib/outbound-fetch.ts', import.meta.url)))
/** @typedef {{url:string,init:{headers:Record<string,string>,body?:string,redirect?:RequestRedirect}}} OutboundCall */
/** @type {{requests:OutboundCall[], response:Response|null, respond:((call:OutboundCall)=>Response|Promise<Response>)|null,
 * aiInput:unknown, aiTestResult:unknown,tokenCalls:number,failFinish:boolean,rpcCalls:string[]}} */
export const boundary = globalThis.__mahsharProviderAuthBoundary ??= { requests: [], response: null, respond: null, aiInput: null, aiTestResult: null,
  tokenCalls: 0, failFinish: false, rpcCalls: [] }
export function resetBoundary() {
  boundary.requests = []; boundary.response = Response.json({ result: 'safe-result' }); boundary.respond = null
  boundary.aiInput = null; boundary.aiTestResult = null; boundary.tokenCalls = 0; boundary.failFinish = false; boundary.rpcCalls = []
  fixture.state.tables.provider_oauth_states = []; fixture.state.tables.provider_oauth_accounts = []
}
function oauthRpc(name, p) {
  boundary.rpcCalls.push(name)
  const tables = fixture.state.tables, accounts = tables.provider_oauth_accounts, states = tables.provider_oauth_states
  const listing = tables.api_listings.find(row => row.id === p.p_api_id)
  if (name === 'mahshar_oauth_claim') {
    if (!listing || listing.encrypted_key !== p.p_ciphertext) return { data: null, error: {} }
    let a = accounts.find(row => row.api_id === p.p_api_id && row.owner_wallet === p.p_wallet && row.account_mode === p.p_mode && row.config_hash === p.p_config_hash)
    if (!a && p.p_create) {
      a = { id: randomUUID(), api_id: p.p_api_id, owner_wallet: p.p_wallet, account_mode: p.p_mode,
        config_hash: p.p_config_hash, status: 'active', revision: 0, encrypted_tokens: null, expires_at: null, lease_id: null }
      accounts.push(a)
    }
    if (a?.status === 'active' && !(a.encrypted_tokens && Date.parse(a.expires_at) > Date.now() + 60000) && !a.lease_id) {
      a.lease_id = p.p_lease; a.lease_until = Date.now() + 30000; a.revision++
    }
    if (a?.lease_id && a.lease_until <= Date.now()) { a.status = 'reauthorization_required'; a.encrypted_tokens = null; a.lease_id = null; a.revision++ }
    return { data: a ? [structuredClone(a)] : [], error: null }
  }
  if (name === 'mahshar_oauth_finish') {
    const a = accounts.find(row => row.id === p.p_id), current = tables.api_listings.find(row => row.id === a?.api_id)
    if (boundary.failFinish || !a || current?.encrypted_key !== p.p_ciphertext || a.lease_id !== p.p_lease || a.revision !== p.p_revision || a.status !== 'active') return { data: false, error: null }
    Object.assign(a, { encrypted_tokens: p.p_tokens, expires_at: p.p_expires, lease_id: null,
      revision: a.revision + 1, status: p.p_tokens ? 'active' : 'reauthorization_required' })
    return { data: true, error: null }
  }
  if (name === 'mahshar_oauth_complete') {
    const s = states.find(row => row.state_hash === p.p_state && row.used_at && Date.parse(row.expires_at) > Date.now())
    const l = tables.api_listings.find(row => row.id === s?.api_id)
    if (!s || l?.encrypted_key !== p.p_ciphertext) return { data: false, error: null }
    let a = accounts.find(row => row.api_id === s.api_id && row.owner_wallet === s.owner_wallet && row.account_mode === s.account_mode && row.config_hash === s.config_hash)
    if (!a) { a = { id: randomUUID(), api_id: s.api_id, owner_wallet: s.owner_wallet, account_mode: s.account_mode, config_hash: s.config_hash, revision: 0 }; accounts.push(a) }
    Object.assign(a, { encrypted_tokens: p.p_tokens, expires_at: p.p_expires, status: 'active', lease_id: null, revision: a.revision + 1 })
    if (s.account_mode === 'seller') Object.assign(l, { is_active: false, verified_at: null })
    tables.provider_oauth_states = states.filter(row => row !== s)
    return { data: true, error: null }
  }
  if (name === 'mahshar_oauth_disconnect') {
    const rows = accounts.filter(row => row.api_id === p.p_api_id && row.owner_wallet === p.p_wallet && row.account_mode === p.p_mode)
    const prior = structuredClone(rows)
    rows.forEach(row => Object.assign(row, { status: 'disconnected', encrypted_tokens: null, expires_at: null, lease_id: null, revision: row.revision + 1 }))
    tables.provider_oauth_states = states.filter(row => !(row.api_id === p.p_api_id && row.owner_wallet === p.p_wallet && row.account_mode === p.p_mode))
    if (p.p_mode === 'seller') Object.assign(listing, { is_active: false, verified_at: null })
    return { data: prior, error: null }
  }
  throw new Error('Unexpected OAuth RPC')
}
Module._load = function(id, parent, main) {
  if (id === '@/lib/outbound-fetch') return { ...outbound, safeOutboundFetch: async (url, init) => {
    const prepared = typeof init === 'function' ? await init(new URL(url)) : { url: new URL(url), outboundInit: init }
    const call = { url: String(prepared.url), init: prepared.outboundInit }
    boundary.requests.push(call)
    if (String(url).includes('/token')) boundary.tokenCalls++
    const response = boundary.respond ? await boundary.respond(call) : boundary.response
    const bytes = await response.clone().arrayBuffer()
    return new Response([204, 205, 304].includes(response.status) ? null : bytes, { status: response.status, headers: response.headers })
  } }
  if (id === '@/lib/supabase/server') return { createServiceClient: () => {
    const db = fixture.createServiceClient()
    return { ...db, rpc: (name, args) => name.startsWith('mahshar_oauth_')
      ? Promise.resolve(oauthRpc(name, args)) : db.rpc(name, args) }
  } }
  if (id === '@/lib/groq') return { scoreApi: async (input, result) => {
    boundary.aiInput = input; boundary.aiTestResult = result
    return { score: 8, suggested_price: 0.01, approved: true, critical_issues: [], warnings: [], positives: [], summary: 'Safe', suggestions: { name: null, description: null, category: null, method: null, auth_type: null, auth_param_name: null, example_request: null, example_response: null, body_required: null, path_parameters: [], query_parameters: [] } }
  } }
  return load.call(this, id, parent, main)
}
