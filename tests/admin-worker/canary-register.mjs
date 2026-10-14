import Module from 'node:module'
import { fileURLToPath } from 'node:url'

const fixture = fileURLToPath(new URL('./canary-fixture.ts', import.meta.url))
const load = Module._load
Module._load = function(specifier, parent, isMain) {
  if (specifier === 'workflow' || specifier === '@/lib/admin-worker/acquisition-runtime'
    || specifier === '@/lib/admin-worker/workflow-steps') return load.call(this, fixture, parent, isMain)
  return load.call(this, specifier, parent, isMain)
}
