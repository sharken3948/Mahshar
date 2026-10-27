export async function resolve(specifier, context, next) {
  if (specifier === 'server-only') return { url: 'data:text/javascript,export{}', shortCircuit: true }
  if (specifier === '@/lib/supabase/server' || /\/src\/lib\/supabase\/server\.(?:ts|js)$/.test(specifier)) return { url: new URL('./phase3-supabase.mjs', import.meta.url).href, shortCircuit: true }
  return next(specifier, context)
}
