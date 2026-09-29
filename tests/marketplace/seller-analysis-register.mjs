import Module from 'node:module'

const load = Module._load
export const sellerAnalysisState = globalThis.__mahsharSellerAnalysisState ??= {
  response: Response.json({ ok: true }),
  outboundCalls: 0,
  outboundUrl: null,
  outboundInit: null,
  urlValidation: { valid: true },
  groqError: false,
  groqInput: null,
  groqResult: {
    score: 8,
    suggested_price: 0.002,
    approved: true,
    critical_issues: [],
    warnings: [],
    positives: ['Clear response'],
    summary: 'Useful endpoint.',
    suggestions: {
      name: 'Suggested API', description: 'A suggested description.', category: 'Data', method: null,
      auth_type: null, auth_param_name: null, example_request: null, example_response: null,
      body_required: null, path_parameters: [], query_parameters: [],
    },
  },
}

export function resetSellerAnalysisState() {
  sellerAnalysisState.response = Response.json({ ok: true })
  sellerAnalysisState.outboundCalls = 0
  sellerAnalysisState.outboundUrl = null
  sellerAnalysisState.outboundInit = null
  sellerAnalysisState.urlValidation = { valid: true }
  sellerAnalysisState.groqError = false
  sellerAnalysisState.groqInput = null
}

class OutboundPolicyError extends Error {
  constructor(classification) { super(classification); this.classification = classification }
}

Module._load = function (id, parent, main) {
  if (id === '@/lib/outbound-fetch') return {
    OutboundPolicyError,
    safeOutboundFetch: async (input, factory) => {
      sellerAnalysisState.outboundCalls++
      const prepared = await factory(new URL(input))
      sellerAnalysisState.outboundUrl = String(prepared.url)
      sellerAnalysisState.outboundInit = prepared.outboundInit
      return sellerAnalysisState.response
    },
  }
  if (id === '@/lib/url-validation') return {
    validateEndpointUrl: async () => sellerAnalysisState.urlValidation,
  }
  if (id === '@/lib/groq') return {
    scoreApi: async (input) => {
      sellerAnalysisState.groqInput = input
      if (sellerAnalysisState.groqError) throw new Error('model unavailable')
      return sellerAnalysisState.groqResult
    },
  }
  return load.call(this, id, parent, main)
}
