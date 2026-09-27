import Module from 'node:module'
const load = Module._load
Module._load = function(specifier, parent, isMain) {
  if (specifier === '@/hooks/useWalletAuthorization') return { useWalletAuthorization: () => ({ request() { throw new Error('Unexpected request') } }) }
  return load.call(this, specifier, parent, isMain)
}
