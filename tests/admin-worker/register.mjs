import '../admin/register.mjs'
import Module from 'node:module'

const load = Module._load
Module._load = function(specifier, parent, isMain) {
  if (specifier === 'workflow') {
    return { sleep: async () => { throw new Error('Durable sleep forbidden in Admin authorization tests') } }
  }
  if (specifier === 'workflow/api') {
    return { start: async (...args) => {
      const fixture = load.call(this, new URL('../admin/fixture.ts', import.meta.url).pathname, parent, isMain)
      if (fixture.boundary.workflowStart) return fixture.boundary.workflowStart(...args)
      throw new Error('Workflow launch forbidden in Admin authorization tests')
    } }
  }
  return load.call(this, specifier, parent, isMain)
}
