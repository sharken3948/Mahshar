import { BridgeKit } from '@circle-fin/bridge-kit'

const kit = new BridgeKit()
const chains = await kit.getSupportedChains()
console.log(JSON.stringify(chains.filter((c: { isTestnet: boolean }) => c.isTestnet), null, 2))
