import '../admin/register.mjs'
import Module from 'node:module'

const load = Module._load
Module._load = function(specifier, parent, isMain) {
  if (specifier === 'workflow/api') {
    return { start: async () => { throw new Error('Workflow launch forbidden in Admin authorization tests') } }
  }
  return load.call(this, specifier, parent, isMain)
}
