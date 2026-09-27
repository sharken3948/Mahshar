// Locally bundled from RainbowKit's installed chain icons, Circle's developer
// chain assets, and Solana's official brand logomark.
// Route availability still comes exclusively from Bridge Kit.
const logos: Record<string, string> = {
  Arbitrum: 'arbitrum', Arc: 'arc', Avalanche: 'avalanche', Base: 'base',
  Codex: 'codex', Cronos: 'cronos', Edge: 'edge', Ethereum: 'ethereum',
  HyperEVM: 'hyperevm', Injective: 'injective', Ink: 'ink', Linea: 'linea',
  Monad: 'monad', Morph: 'morph', Optimism: 'optimism', Pharos: 'pharos',
  Plasma: 'plasma', Plume: 'plume', Polygon: 'polygon', Sei: 'sei',
  Solana: 'solana', Sonic: 'sonic', Unichain: 'unichain',
  World_Chain: 'world_chain', XDC: 'xdc', X_Layer: 'x_layer',
}

export function chainLogoPath(chain: string): string | undefined {
  const asset = logos[chain]
  return asset ? `/chain-logos/${asset}.svg` : undefined
}
