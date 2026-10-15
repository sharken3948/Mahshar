import Module from 'node:module'
import { fileURLToPath } from 'node:url'

const fixtureFetch = globalThis.fetch
await import('./register.mjs')
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  // The existing bounded-fetch regression uses its own ephemeral loopback HTTP
  // server. Every external destination remains forbidden.
  if (url.protocol === 'http:' && url.hostname === '127.0.0.1') return fixtureFetch(input, init)
  throw new Error('External network forbidden in contact coverage tests')
}

const load = Module._load
Module._load = function(specifier, parent, isMain) {
  if (specifier === '@/lib/outbound-fetch') return {
    ...load.call(this, fileURLToPath(new URL('../../src/lib/outbound-fetch.ts', import.meta.url)), parent, isMain),
    safeOutboundFetch: async () => { throw new Error('Network forbidden in contact coverage tests') },
  }
  if (specifier === 'groq-sdk') return class ForbiddenInference {
    chat = { completions: { create: async () => { throw new Error('Live inference forbidden in contact coverage tests') } } }
  }
  return load.call(this, specifier, parent, isMain)
}
