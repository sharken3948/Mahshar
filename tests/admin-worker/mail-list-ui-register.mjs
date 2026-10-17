import './dashboard-ui-register.mjs'
import Module from 'node:module'
const load = Module._load
Module._load = function(specifier, parent, isMain) {
  if (specifier === 'next/navigation') return { usePathname: () => '/admin/operations/pending-emails' }
  return load.call(this, specifier, parent, isMain)
}
