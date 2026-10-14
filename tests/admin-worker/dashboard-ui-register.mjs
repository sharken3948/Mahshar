import './register.mjs'
import Module from 'node:module'
const load = Module._load
Module._load = function(specifier, parent, isMain) {
  if (specifier === '@/components/AdminAccess') return { useAdminRequest: () => async () => { throw new Error('UI render must not perform requests') } }
  return load.call(this, specifier, parent, isMain)
}
