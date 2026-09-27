const replacements = new Map([
  ['@/lib/supabase/server', './fixtures.ts'],
  ['@/lib/groq', './stubs.ts'], ['@/lib/gateway', './stubs.ts'],
  ['@/lib/memo', './stubs.ts'], ['@/lib/url-validation', './stubs.ts'],
  ['next/server', './next.ts'],
])
export async function resolve(specifier, context, next) {
  if (specifier === 'server-only') return { url: 'data:text/javascript,export{}', shortCircuit: true }
  if (replacements.has(specifier)) return { url: new URL(replacements.get(specifier), import.meta.url).href, shortCircuit: true }
  return next(specifier, context)
}
