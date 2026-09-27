import Module from 'node:module'

const load = Module._load
/** @type {{response:Response|null,targetUrl:string|null,outboundUrl:string|null,outboundInit:RequestInit|null}} */
export const proxyState = globalThis.__mahsharProxyDiagnosticState ??= {
  response: null,
  targetUrl: null,
  outboundUrl: null,
  outboundInit: null,
}

export function resetProxyState() {
  proxyState.response = null
  proxyState.targetUrl = null
  proxyState.outboundUrl = null
  proxyState.outboundInit = null
}

Module._load = function (id, parent, main) {
  if (id === '@/lib/outbound-fetch') return {
    safeOutboundFetch: async (input, init) => {
      proxyState.targetUrl = String(input)
      const prepared = typeof init === 'function' ? await init(new URL(input)) : init
      if (prepared && 'outboundInit' in prepared) {
        proxyState.outboundUrl = String(prepared.url)
        proxyState.outboundInit = prepared.outboundInit
      } else {
        proxyState.outboundUrl = String(input)
        proxyState.outboundInit = prepared
      }
      if (!proxyState.response) throw new Error('Missing synthetic upstream response')
      return proxyState.response
    },
  }
  return load.call(this, id, parent, main)
}
