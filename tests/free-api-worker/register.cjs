const Module = require('node:module')
const original = Module._load
Module._load = function(specifier, parent, main) {
  if (specifier === 'server-only') return {}
  if (specifier === '@/lib/supabase/server') throw new Error('Existing database access forbidden in Worker tests')
  return original.call(this, specifier, parent, main)
}
