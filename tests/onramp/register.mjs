import Module from 'node:module'

const load = Module._load
Module._load = function (specifier, parent, isMain) {
  if (specifier === 'server-only') return {}
  if (specifier === '@/lib/supabase/server') return { createServiceClient: () => { throw new Error('Database access forbidden in Onramp unit tests') } }
  return load.call(this, specifier, parent, isMain)
}

process.env.MARKETPLACE_ORIGIN = 'http://localhost:3000'
