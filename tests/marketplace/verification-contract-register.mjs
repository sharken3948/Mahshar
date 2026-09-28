import Module from 'node:module'

const load = Module._load
export const verificationState = globalThis.__mahsharVerificationState ??= {
  url: null,
  init: null,
}
export function resetVerificationState() { verificationState.url = null; verificationState.init = null }

Module._load = function (id, parent, main) {
  if (id === '@/lib/outbound-fetch') return {
    safeOutboundFetch: async (input, factory) => {
      const prepared = await factory(new URL(input))
      verificationState.url = String(prepared.url)
      verificationState.init = prepared.outboundInit
      return Response.json({ ok: true })
    },
  }
  return load.call(this, id, parent, main)
}
