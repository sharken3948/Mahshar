import Module from 'node:module'

const load = Module._load
Module._load = function(specifier, parent, isMain) {
  if (specifier === 'server-only') return {}
  return load.call(this, specifier, parent, isMain)
}

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://fixture.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'fixture-anon'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fixture-service'
