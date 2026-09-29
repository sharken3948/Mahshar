import type { EIP1193Provider } from 'viem'

export const WALLET_CHAIN_SYNC_TIMEOUT_MS = 12_000
export const WALLET_CHAIN_SYNC_POLL_MS = 120

type ChainIdReader = () => number | undefined | Promise<number | undefined>
type WaitOptions = {
  timeoutMs?: number
  pollMs?: number
  sleep?: (milliseconds: number) => Promise<void>
}

export class WalletChainTransitionError extends Error {
  readonly targetChainId: number
  readonly targetName: string

  constructor(targetChainId: number, targetName: string, cause?: unknown) {
    super(`Switch to ${targetName} to continue.`, { cause })
    this.name = 'WalletChainTransitionError'
    this.targetChainId = targetChainId
    this.targetName = targetName
  }
}

export function numericChainId(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, value.startsWith('0x') ? 16 : 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

export async function providerChainId(provider: EIP1193Provider) {
  return numericChainId(await provider.request({ method: 'eth_chainId' }))
}

/**
 * Waits for the wallet provider itself to report the target chain. React and
 * connector state are intentionally not accepted as proof of a completed
 * switch because mobile wallets can publish those values before their active
 * JSON-RPC provider has changed networks.
 */
export async function waitForProviderChain(
  provider: EIP1193Provider,
  targetChainId: number,
  options: WaitOptions = {},
) {
  const timeoutMs = options.timeoutMs ?? WALLET_CHAIN_SYNC_TIMEOUT_MS
  const pollMs = options.pollMs ?? WALLET_CHAIN_SYNC_POLL_MS
  const sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)))
  const deadline = Date.now() + timeoutMs
  let activeChainId = await providerChainId(provider)
  while (activeChainId !== targetChainId) {
    if (Date.now() >= deadline) return { confirmed: false as const, providerChainId: activeChainId }
    await sleep(pollMs)
    activeChainId = await providerChainId(provider)
  }
  return { confirmed: true as const, providerChainId: activeChainId }
}

export function isRawChainMismatch(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return /ChainMismatchError|chainId mismatch|Active chainId is .*received/i.test(message)
}

export function walletChainErrorMessage(error: unknown, fallbackTarget = 'the required network') {
  if (error instanceof WalletChainTransitionError) return error.message
  if (isRawChainMismatch(error)) return `Your wallet network is still updating. Switch to ${fallbackTarget} to continue.`
  return error instanceof Error ? error.message : String(error)
}

export async function walletChainSnapshot(provider: EIP1193Provider, getConnectorChainId: ChainIdReader) {
  const [providerValue, connectorValue] = await Promise.all([
    provider.request({ method: 'eth_chainId' }),
    getConnectorChainId(),
  ])
  return { providerChainId: numericChainId(providerValue), connectorChainId: numericChainId(connectorValue) }
}

export async function waitForWalletChain(
  provider: EIP1193Provider,
  getConnectorChainId: ChainIdReader,
  targetChainId: number,
  options: WaitOptions = {},
) {
  const timeoutMs = options.timeoutMs ?? WALLET_CHAIN_SYNC_TIMEOUT_MS
  const pollMs = options.pollMs ?? WALLET_CHAIN_SYNC_POLL_MS
  const sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)))
  const deadline = Date.now() + timeoutMs
  let snapshot = await walletChainSnapshot(provider, getConnectorChainId)
  while (snapshot.providerChainId !== targetChainId || snapshot.connectorChainId !== targetChainId) {
    if (Date.now() >= deadline) return { confirmed: false as const, ...snapshot }
    await sleep(pollMs)
    snapshot = await walletChainSnapshot(provider, getConnectorChainId)
  }
  return { confirmed: true as const, ...snapshot }
}

export async function switchWalletChainAndWait({
  provider,
  getConnectorChainId,
  switchChain,
  targetChainId,
  targetName,
  onSwitching,
  options,
}: {
  provider: EIP1193Provider
  getConnectorChainId: ChainIdReader
  switchChain: () => Promise<unknown>
  targetChainId: number
  targetName: string
  onSwitching?: () => void
  options?: WaitOptions
}) {
  try {
    const current = await walletChainSnapshot(provider, getConnectorChainId)
    if (current.providerChainId !== targetChainId || current.connectorChainId !== targetChainId) {
      onSwitching?.()
      await switchChain()
    }
    const settled = await waitForWalletChain(provider, getConnectorChainId, targetChainId, options)
    if (!settled.confirmed) throw new Error('Wallet provider and connector did not synchronize in time')
    return settled
  } catch (error) {
    throw error instanceof WalletChainTransitionError
      ? error
      : new WalletChainTransitionError(targetChainId, targetName, error)
  }
}

/** Keeps Circle's internal viem switch from resolving before an injected wallet actually changes chain. */
export function chainSynchronizedProvider(
  provider: EIP1193Provider,
  getConnectorChainId: ChainIdReader,
  chainName: (chainId: number) => string,
  onTransition: (state: { status: 'switching' | 'required'; targetChainId: number; targetName: string } | null) => void,
  options?: WaitOptions,
): EIP1193Provider {
  const request = (async (args: { method: string; params?: unknown }) => {
    if (args.method !== 'wallet_switchEthereumChain') {
      return provider.request(args as Parameters<EIP1193Provider['request']>[0])
    }
    const targetValue = Array.isArray(args.params) && args.params[0] && typeof args.params[0] === 'object'
      ? (args.params[0] as { chainId?: unknown }).chainId : null
    const targetChainId = numericChainId(targetValue)
    if (!targetChainId) return provider.request(args as Parameters<EIP1193Provider['request']>[0])
    const targetName = chainName(targetChainId)
    onTransition({ status: 'switching', targetChainId, targetName })
    try {
      const result = await provider.request(args as Parameters<EIP1193Provider['request']>[0])
      const settled = await waitForWalletChain(provider, getConnectorChainId, targetChainId, options)
      if (!settled.confirmed) throw new Error('Wallet provider and connector did not synchronize in time')
      onTransition(null)
      return result
    } catch (error) {
      onTransition({ status: 'required', targetChainId, targetName })
      throw new WalletChainTransitionError(targetChainId, targetName, error)
    }
  }) as EIP1193Provider['request']
  return {
    request,
    on: provider.on?.bind(provider) ?? (() => undefined),
    removeListener: provider.removeListener?.bind(provider) ?? (() => undefined),
  }
}
