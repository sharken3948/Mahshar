export interface ArcBalanceWindowTarget {
  addEventListener: (event: 'focus', listener: () => void) => void
  removeEventListener: (event: 'focus', listener: () => void) => void
}

export interface ArcBalanceDocumentTarget {
  visibilityState: string
  addEventListener: (event: 'visibilitychange', listener: () => void) => void
  removeEventListener: (event: 'visibilitychange', listener: () => void) => void
}

export interface ArcBalanceEventProvider {
  on?: (event: string, listener: (...args: unknown[]) => void) => void
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void
}

export function bindArcBalanceBrowserRecovery(
  recover: () => void,
  windowTarget: ArcBalanceWindowTarget,
  documentTarget: ArcBalanceDocumentTarget,
) {
  const onVisibility = () => { if (documentTarget.visibilityState === 'visible') recover() }
  windowTarget.addEventListener('focus', recover)
  documentTarget.addEventListener('visibilitychange', onVisibility)
  return () => {
    windowTarget.removeEventListener('focus', recover)
    documentTarget.removeEventListener('visibilitychange', onVisibility)
  }
}

export function bindArcBalanceProviderRecovery(provider: ArcBalanceEventProvider, recover: () => void) {
  provider.on?.('connect', recover)
  provider.on?.('chainChanged', recover)
  provider.on?.('accountsChanged', recover)
  return () => {
    provider.removeListener?.('connect', recover)
    provider.removeListener?.('chainChanged', recover)
    provider.removeListener?.('accountsChanged', recover)
  }
}
