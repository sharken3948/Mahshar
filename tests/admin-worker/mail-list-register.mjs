import Module, { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

// Reuse the existing authentication fixtures and actual URL policy. Only the
// bounded-fetch regression's local server may receive requests.
const fixtureFetch = globalThis.fetch
createRequire(import.meta.url)('./register.mjs')
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (url.protocol === 'http:' && url.hostname === '127.0.0.1') return fixtureFetch(input, init)
  throw new Error('External network forbidden in Pending Emails tests')
}
const load = Module._load
Module._load = function(specifier, parent, isMain) {
  if (specifier === '@/lib/outbound-fetch') return {
    ...load.call(this, fileURLToPath(new URL('../../src/lib/outbound-fetch.ts', import.meta.url)), parent, isMain),
    safeOutboundFetch: async () => { throw new Error('External request forbidden in Pending Emails tests') },
  }
  if (specifier === 'groq-sdk') return class ForbiddenInference {
    chat = { completions: { create: async () => { throw new Error('Live inference forbidden in Pending Emails tests') } } }
  }
  return load.call(this, specifier, parent, isMain)
}
