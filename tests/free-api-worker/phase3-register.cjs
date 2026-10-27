require('./integration-register.cjs')
const Module = require('node:module')
Module.register('./phase3-loader.mjs', require('node:url').pathToFileURL(__filename))
const path = require('node:path')
const original = Module._load
Module._load = function(specifier, parent, main) {
  const adapter = () => original.call(this, path.join(__dirname, 'phase3-adapter.ts'), parent, main)
  if (specifier === '@/lib/supabase/server') return adapter()
  if (specifier === '@/lib/url-validation') return { validateEndpointUrl: async url => ({ valid: new URL(url).hostname.endsWith('.example.org') }) }
  if (specifier === '@/lib/outbound-fetch') return { ...original.call(this,specifier,parent,main), safeOutboundFetch: adapter().safeOutboundFetch }
  if (specifier === '@/lib/gateway' || specifier === '@/lib/memo') return new Proxy({}, { get: () => () => { adapter().outbound.paidCalls++; throw new Error('Financial operations forbidden') } })
  return original.call(this,specifier,parent,main)
}
