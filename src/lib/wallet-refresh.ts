export const TARGETED_REFRESH_DELAY_MS = 10_000
export const TARGETED_REFRESH_RETRY_DELAY_MS = 20_000

export type WalletRefreshResource =
  | 'arcWallet'
  | 'gateway'
  | 'pendingWithdrawal'
  | 'evmBridge'
  | 'solana'
  | 'sellerEarnings'

export type WalletRefreshAction =
  | { kind: 'gatewayDeposit' }
  | { kind: 'gatewayWithdrawal' }
  | { kind: 'trustlessWithdrawalInitiated' }
  | { kind: 'trustlessWithdrawalReleased' }
  | { kind: 'sellerWithdrawal' }
  | { kind: 'bridge'; source: 'evm' | 'solana' }

const ACTION_RESOURCES: Record<Exclude<WalletRefreshAction['kind'], 'bridge'>, readonly WalletRefreshResource[]> = {
  gatewayDeposit: ['arcWallet', 'gateway'],
  gatewayWithdrawal: ['arcWallet', 'gateway'],
  trustlessWithdrawalInitiated: ['arcWallet', 'gateway', 'pendingWithdrawal'],
  trustlessWithdrawalReleased: ['arcWallet', 'pendingWithdrawal'],
  sellerWithdrawal: ['arcWallet', 'sellerEarnings'],
}

export function walletRefreshResources(action: WalletRefreshAction): readonly WalletRefreshResource[] {
  if (action.kind === 'bridge') return action.source === 'solana' ? ['arcWallet', 'solana'] : ['arcWallet', 'evmBridge']
  return ACTION_RESOURCES[action.kind] ?? []
}

interface SchedulerOptions {
  getScope: () => string | null
  refresh: (resources: ReadonlySet<WalletRefreshResource>, scope: string) => Promise<unknown>
  getSnapshot?: (resource: WalletRefreshResource, scope: string) => unknown
  setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
}

export function createTargetedWalletRefreshScheduler(options: SchedulerOptions) {
  const setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay))
  const clearTimer = options.clearTimer ?? (timer => clearTimeout(timer))
  let scope: string | null = null
  let resources = new Set<WalletRefreshResource>()
  let firstTimer: ReturnType<typeof setTimeout> | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let inFlight: Promise<void> | null = null
  let retryAfterInFlight = false
  let finalAttemptRunning = false
  let queuedActions: WalletRefreshAction[] = []
  let baselines = new Map<WalletRefreshResource, unknown>()

  const normalizedScope = () => options.getScope()?.toLowerCase() ?? null
  const clearWindow = () => {
    if (firstTimer !== null) clearTimer(firstTimer)
    if (retryTimer !== null) clearTimer(retryTimer)
    firstTimer = null
    retryTimer = null
    retryAfterInFlight = false
    finalAttemptRunning = false
    resources = new Set()
    baselines = new Map()
    scope = null
  }

  const run = (finalAttempt: boolean) => {
    if (!scope || normalizedScope() !== scope) { clearWindow(); return }
    if (inFlight) {
      if (finalAttempt) retryAfterInFlight = true
      return
    }
    const requestedScope = scope
    const requestedResources = new Set(finalAttempt && options.getSnapshot
      ? [...resources].filter(resource => Object.is(options.getSnapshot!(resource, requestedScope), baselines.get(resource)))
      : resources)
    if (!requestedResources.size) { if (finalAttempt) clearWindow(); return }
    finalAttemptRunning = finalAttempt
    const request = Promise.resolve().then(() => options.refresh(requestedResources, requestedScope)).catch(() => {}).then(() => {})
    inFlight = request
    void request.finally(() => {
      if (inFlight === request) inFlight = null
      if (scope !== requestedScope) return
      if (!finalAttempt && retryAfterInFlight) {
        retryAfterInFlight = false
        run(true)
        return
      }
      if (finalAttempt) {
        const nextActions = queuedActions
        queuedActions = []
        clearWindow()
        for (const action of nextActions) schedule(action)
      }
    })
  }

  const schedule = (action: WalletRefreshAction) => {
    const nextScope = normalizedScope()
    if (!nextScope) return
    if (finalAttemptRunning && inFlight && firstTimer === null && retryTimer === null) {
      queuedActions.push(action)
      return
    }
    if (scope && scope !== nextScope) clearWindow()
    scope = nextScope
    for (const resource of walletRefreshResources(action)) {
      if (options.getSnapshot && (!resources.has(resource) || firstTimer === null)) baselines.set(resource, options.getSnapshot(resource, nextScope))
      resources.add(resource)
    }
    if (!resources.size || firstTimer !== null || retryTimer !== null || inFlight) return
    firstTimer = setTimer(() => { firstTimer = null; run(false) }, TARGETED_REFRESH_DELAY_MS)
    retryTimer = setTimer(() => { retryTimer = null; run(true) }, TARGETED_REFRESH_RETRY_DELAY_MS)
  }

  return { schedule, cancel: () => { queuedActions = []; clearWindow() } }
}
