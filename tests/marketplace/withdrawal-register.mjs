import Module from 'node:module'
import { createRequire } from 'node:module'

const load = Module._load
const viem = createRequire(import.meta.url)('viem')

Module._load = function (id, parent, main) {
  if (id === 'viem') return {
    ...viem,
    createPublicClient: () => ({
      verifyMessage: async ({ address, message, signature }) => {
        try {
          const recovered = await viem.recoverMessageAddress({ message, signature })
          return recovered.toLowerCase() === address.toLowerCase()
        } catch {
          return false
        }
      },
    }),
  }
  return load.call(this, id, parent, main)
}
