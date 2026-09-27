import { MAINNET_CHAINS, discoverCircleRoutes } from '../src/lib/circle-bridge'

const { routes, excluded } = await discoverCircleRoutes()
console.log(JSON.stringify({
  candidateMainnets: MAINNET_CHAINS.length,
  confirmedRoutes: routes.length,
  routes: routes.map(({ source, useForwarder }) => ({ name: source.name, chain: source.chain, ecosystem: source.type, destination: 'Arc', token: 'USDC', useForwarder })),
  excluded,
}, null, 2))
