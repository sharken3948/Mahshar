import { Arc, Blockchain, BridgeKit, type ChainDefinition, type BridgeResult } from '@circle-fin/bridge-kit'
import { formatUnits, parseUnits } from 'viem'

// Circle's registry is the chain universe; capability checks determine selectable routes.
export const MAINNET_CHAINS = new BridgeKit().getSupportedChains({ isTestnet: false })
export interface CircleRoute { source: ChainDefinition; useForwarder: boolean }
export interface CircleRoutes { routes: CircleRoute[]; excluded: { name: string; reason: string }[] }

export async function discoverCircleRoutes(kit = new BridgeKit()): Promise<CircleRoutes> {
  const routes: CircleRoute[] = []
  const excluded: CircleRoutes['excluded'] = []
  for (const source of kit.getSupportedChains({ isTestnet: false })) {
    let reason = 'SDK does not support native USDC to Arc'
    if (source.chain === Arc.chain) reason = 'Destination chain; use Wallet Deposit'
    else if (source.isTestnet || !source.usdcAddress) reason = 'Mainnet native USDC required'
    else if (source.type !== 'evm' && source.type !== 'solana') reason = 'No supported browser wallet adapter'
    else {
      // Match Bridge Kit's ordered provider selection, stopping at the first supported route.
      for (const provider of kit.providers) {
        try {
          // The providers publish separate bundled ChainDefinition enum types.
          // Their public capability signature accepts the same SDK chain objects.
          const capability = provider as unknown as {
            supportsRoute(source: ChainDefinition, destination: ChainDefinition, token: 'USDC', forwarding?: boolean): boolean | Promise<boolean>
          }
          if (!await capability.supportsRoute(source, Arc, 'USDC')) continue
          const useForwarder = await capability.supportsRoute(source, Arc, 'USDC', true)
          routes.push({ source, useForwarder })
          break
        } catch { reason = 'SDK route capability temporarily unavailable' }
      }
      if (routes.some(route => route.source.chain === source.chain)) continue
    }
    excluded.push({ name: source.name, reason })
  }
  return { routes, excluded }
}

export function bridgeSource(value: string) {
  const source = MAINNET_CHAINS.find(chain => chain.chain === value)
  if (!source || source.chain === Arc.chain || !source.usdcAddress || (source.type !== 'evm' && source.type !== 'solana')) throw new Error('Choose a supported Mainnet USDC source.')
  return source
}

export function usdcAmount(value: string): string {
  if (!/^\d+(\.\d{1,6})?$/.test(value) || parseUnits(value, 6) <= BigInt(0)) throw new Error('Enter a positive USDC amount with at most 6 decimals.')
  return formatUnits(parseUnits(value, 6), 6)
}

/** Guard saved SDK recovery data. No protocol implementation or CCTP encoding. */
export function validateBridgeResult(result: BridgeResult, recipient: string) {
  bridgeSource(result.source?.chain?.chain)
  usdcAmount(result.amount)
  if (result.token !== 'USDC' || result.destination?.chain?.chain !== Blockchain.Arc
    || result.destination.chain.isTestnet || (result.destination.useForwarder !== undefined && typeof result.destination.useForwarder !== 'boolean')
    || (result.destination.recipientAddress ?? result.destination.address)?.toLowerCase() !== recipient.toLowerCase()
    || result.source.chain.isTestnet || !['success', 'pending', 'error'].includes(result.state) || !Array.isArray(result.steps)) {
    throw new Error('Saved transfer does not match this Mainnet USDC route and wallet.')
  }
}
