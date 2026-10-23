import '../marketplace/register.mjs'
import Module from 'node:module'
import { fileURLToPath } from 'node:url'

const load = Module._load
const outbound = load.call(Module, fileURLToPath(new URL('../../src/lib/outbound-fetch.ts', import.meta.url)))
/** @typedef {{url:string,init:{headers:Record<string,string>,body?:string,redirect?:RequestRedirect}}} OutboundCall */
/** @type {{requests:OutboundCall[], response:Response|null, respond:((call:OutboundCall)=>Response|Promise<Response>)|null,
 * aiInput:unknown, aiTestResult:unknown}} */
export const boundary = globalThis.__mahsharProviderAuthBoundary ??= { requests: [], response: null, respond: null, aiInput: null, aiTestResult: null,
  }
export function resetBoundary() {
  boundary.requests = []; boundary.response = Response.json({ result: 'safe-result' }); boundary.respond = null
  boundary.aiInput = null; boundary.aiTestResult = null;
}
Module._load = function(id, parent, main) {
  if (id === '@/lib/outbound-fetch') return { ...outbound, safeOutboundFetch: async (url, init) => {
    const prepared = typeof init === 'function' ? await init(new URL(url)) : { url: new URL(url), outboundInit: init }
    const call = { url: String(prepared.url), init: prepared.outboundInit }
    boundary.requests.push(call)
    const response = boundary.respond ? await boundary.respond(call) : boundary.response
    const bytes = await response.clone().arrayBuffer()
    return new Response([204, 205, 304].includes(response.status) ? null : bytes, { status: response.status, headers: response.headers })
  } }
  if (id === '@/lib/groq') return { scoreApi: async (input, result) => {
    boundary.aiInput = input; boundary.aiTestResult = result
    return { score: 8, suggested_price: 0.01, approved: true, critical_issues: [], warnings: [], positives: [], summary: 'Safe', suggestions: { name: null, description: null, category: null, method: null, auth_type: null, auth_param_name: null, example_request: null, example_response: null, body_required: null, path_parameters: [], query_parameters: [] } }
  } }
  return load.call(this, id, parent, main)
}
