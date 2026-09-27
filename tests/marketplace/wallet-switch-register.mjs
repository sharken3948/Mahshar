import Module from 'node:module'

const load = Module._load
export const alice = `0x${'11'.repeat(20)}`
export const bob = `0x${'22'.repeat(20)}`
export const signature = `0x${'33'.repeat(65)}`
/** @type {{address:string, fetches:Array<{input:string,init?:RequestInit}>, signatures:Array<{input:any,resolve:(value:string)=>void,reject:(reason?:unknown)=>void}>}} */
export const state = globalThis.__mahsharWalletSwitchState ??= {
  address: alice,
  fetches: [],
  signatures: [],
}

export function reset() {
  state.address = alice
  state.fetches = []
  state.signatures = []
}

function signTypedDataAsync(input) {
  return new Promise((resolve, reject) => state.signatures.push({ input, resolve, reject }))
}

globalThis.window = { location: { origin: 'https://mahshar.xyz' } }
globalThis.fetch = async (input, init) => {
  state.fetches.push({ input: String(input), init })
  return Response.json({ ok: true })
}

Module._load = function (id, parent, main) {
  if (id === 'react') return { useCallback: value => value }
  if (id === 'wagmi') return {
    useConfig: () => state,
    useSignTypedData: () => ({ signTypedDataAsync }),
  }
  if (id === '@wagmi/core') return { getAccount: config => ({ address: config.address }) }
  return load.call(this, id, parent, main)
}
