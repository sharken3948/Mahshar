const replacements = new Map([
  ['@/lib/supabase/server', './fixture-server.mjs'],
  ['@/lib/groq', './stubs.ts'], ['@/lib/gateway', './stubs.ts'],
  ['@/lib/url-validation', './stubs.ts'],
  ['next/server', './next.ts'],
])
export async function resolve(specifier, context, next) {
  if (specifier === 'server-only') return { url: 'data:text/javascript,export{}', shortCircuit: true }
  // Let tsx resolve the replacement's TypeScript format too. Short-circuiting
  // here bypasses its format metadata for real dynamic imports (SEO readers).
  if (replacements.has(specifier)) return next(new URL(replacements.get(specifier), import.meta.url).href, context)
  return next(specifier, context)
}
