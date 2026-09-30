'use client'

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { MintedOnrampSession, OnrampKit, OnrampWidget } from '@circle-fin/onramp-kit'
import Image from 'next/image'
import { useMarketplaceSession } from './MarketplaceSessionProvider'
import styles from './onramp.module.css'

type OnrampPhase = 'loading' | 'ready' | 'opened' | 'submitted' | 'settled' | 'cancelled' | 'unavailable' | 'error'
type OpenOptions = { onBalanceRefresh?: () => void }
type OnrampContextValue = { open: (options?: OpenOptions) => void }

const OnrampContext = createContext<OnrampContextValue | null>(null)

export function OnrampProvider({ children }: { children: React.ReactNode }) {
  const { wallet, request } = useMarketplaceSession()
  const [visible, setVisible] = useState(false)
  const [phase, setPhase] = useState<OnrampPhase>('loading')
  const [session, setSession] = useState<MintedOnrampSession | null>(null)
  const [kit, setKit] = useState<OnrampKit | null>(null)
  const [phoneConsent, setPhoneConsent] = useState(false)
  const requestSequence = useRef(0)
  const requestController = useRef<AbortController | null>(null)
  const widget = useRef<OnrampWidget | null>(null)
  const refreshBalance = useRef<(() => void) | undefined>(undefined)
  const refreshSent = useRef(false)

  const notifyBalanceRefresh = useCallback(() => {
    if (refreshSent.current) return
    refreshSent.current = true
    try { refreshBalance.current?.() } catch { /* Funding remains independent of Mahshar UI refresh. */ }
  }, [])

  const finish = useCallback((next: Extract<OnrampPhase, 'settled' | 'cancelled' | 'unavailable' | 'error'>) => {
    setPhase(next)
    notifyBalanceRefresh()
    const active = widget.current
    widget.current = null
    active?.close()
  }, [notifyBalanceRefresh])

  const open = useCallback((options: OpenOptions = {}) => {
    setVisible(true)
    refreshBalance.current = options.onBalanceRefresh
    if (widget.current) return

    requestController.current?.abort()
    const controller = new AbortController()
    requestController.current = controller
    const sequence = ++requestSequence.current
    refreshSent.current = false
    setSession(null)
    setKit(null)
    setPhoneConsent(false)

    if (!wallet) {
      setPhase('error')
      return
    }

    setPhase('loading')
    void Promise.all([
      request('/api/onramp/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ destinationAddress: wallet }),
        signal: controller.signal,
      }),
      import('@circle-fin/onramp-kit'),
    ]).then(async ([response, module]) => {
      const body = await response.json().catch(() => null) as MintedOnrampSession | { error?: unknown } | null
      if (sequence !== requestSequence.current || controller.signal.aborted) return
      if (!response.ok) {
        setPhase(response.status === 503 ? 'unavailable' : 'error')
        return
      }
      setSession(body as MintedOnrampSession)
      setKit(module.createOnrampKit())
      setPhase('ready')
    }).catch(error => {
      if (sequence !== requestSequence.current || controller.signal.aborted) return
      setPhase(error instanceof DOMException && error.name === 'AbortError' ? 'cancelled' : 'unavailable')
    })
  }, [request, wallet])

  const launch = useCallback(() => {
    if (!kit || !session || !phoneConsent) return
    try {
      const result = kit.openWindow({
        session,
        onInitializationSuccess: () => setPhase('opened'),
        onInitializationError: () => finish('unavailable'),
        onDepositSubmitted: () => setPhase('submitted'),
        onDepositSettled: () => finish('settled'),
        onDepositNotCompleted: envelope => finish(envelope.code === 'CANCELED_BY_CUSTOMER' ? 'cancelled' : 'unavailable'),
      })
      if (result.status === 'blocked') {
        setPhase('error')
        return
      }
      widget.current = result.widget
      setPhase('opened')
    } catch {
      setPhase('unavailable')
    }
  }, [finish, kit, phoneConsent, session])

  const closePanel = useCallback(() => {
    setVisible(false)
    if (!widget.current) {
      requestSequence.current += 1
      requestController.current?.abort()
      requestController.current = null
      setSession(null)
      setKit(null)
    }
  }, [])

  useEffect(() => {
    return () => {
      requestSequence.current += 1
      requestController.current?.abort()
      widget.current?.close()
      widget.current = null
    }
  }, [])

  useEffect(() => {
    requestSequence.current += 1
    requestController.current?.abort()
    requestController.current = null
    widget.current?.close()
    widget.current = null
    setVisible(false)
    setSession(null)
    setKit(null)
  }, [wallet])

  return (
    <OnrampContext.Provider value={{ open }}>
      {children}
      {visible && <div className={styles.overlay} role="presentation">
        <button type="button" className={styles.backdrop} aria-label="Close Add USDC panel" onClick={closePanel} />
        <section className={styles.panel} role="dialog" aria-modal="true" aria-labelledby="onramp-title" aria-describedby="onramp-description">
          <header className={styles.header}>
            <button type="button" className={styles.close} aria-label="Close Add USDC panel" onClick={closePanel}>×</button>
          </header>
          <div className={styles.body}>
            <div className={styles.hero}>
              <span className={styles.usdcIcon}><Image src="/brand/usdc-token.svg" width={96} height={96} alt="USDC" /></span>
              <p className={styles.eyebrow}>ARC WALLET FUNDING</p>
              <h2 id="onramp-title">Add USDC</h2>
              <p id="onramp-description" className={styles.lead}>Fund your Arc Mainnet wallet through Circle Onramp.</p>
            </div>

            <div className={styles.route} aria-label="Fund USDC on Arc">
              <div className={styles.routeNode}><span>FROM</span><strong>Fiat</strong></div>
              <i aria-hidden="true">→</i>
              <div className={`${styles.routeNode} ${styles.routeDestination}`}>
                <span>FUND</span>
                <strong>Arc USDC</strong>
                <small><b>Arc Mainnet</b><b>USDC</b></small>
              </div>
            </div>

            <div className={styles.methodCard}>
              <span className={styles.methodIcon} aria-hidden="true">i</span>
              <div>
                <strong>Supported fiat payment methods</strong>
                <p>Available options are shown by Circle and vary by region and provider.</p>
              </div>
            </div>

            {phase === 'loading' && <Status title="Preparing Circle Onramp…">Mahshar remains available while the short-lived funding session is created.</Status>}
            {phase === 'ready' && <>
              <Status title="Ready to continue">Circle’s hosted flow handles payment details, identity checks, fees, and eligibility.</Status>
              <div className={styles.consentBlock}>
                <label className={styles.consent}>
                  <input type="checkbox" checked={phoneConsent} onChange={event => setPhoneConsent(event.target.checked)} />
                  <span>I acknowledge the phone-verification consent below.</span>
                </label>
                <p className={styles.consentCopy}>You authorize your wireless carrier to use or disclose information about your account and your wireless device, if available, to Circle or its service provider, solely for the purposes of identifying you or your wireless device and to prevent fraud. For more information regarding your wireless carrier’s use of your personal information, please refer to your wireless carrier’s Privacy Policy.</p>
              </div>
              <button type="button" className={styles.primary} disabled={!phoneConsent} onClick={launch}>Open Circle Onramp</button>
            </>}
            {phase === 'opened' && <Status title="Circle Onramp is open">Complete or cancel funding in the Circle window. Closing this panel will not interrupt that window.</Status>}
            {phase === 'submitted' && <Status title="Funding submitted">The provider is processing the transaction. Your independently observed Arc USDC balance remains the source of truth.</Status>}
            {phase === 'settled' && <Status title="Funding reported complete" tone="success">Mahshar requested a fresh Arc wallet balance. Start any API purchase again explicitly after the balance appears.</Status>}
            {phase === 'cancelled' && <Status title="Funding not completed">Nothing in Mahshar changed. You can keep using Mahshar or try again later.</Status>}
            {phase === 'unavailable' && <Status title="Onramp unavailable" tone="warning">Circle or its payment provider could not complete this funding flow. Mahshar and your existing payment flows are unaffected.</Status>}
            {phase === 'error' && <Status title="Could not open Onramp" tone="warning">Connect and sign in on Arc Mainnet, allow the Circle popup, then choose Add USDC again. Mahshar remains available.</Status>}

            <div className={styles.legal}>
              <p>Fiat onramp transactions are processed by third-party payment processors.</p>
              <p>You will review applicable provider terms in Circle’s flow.</p>
              <p>Offramp functionality is not currently available through this feature.</p>
            </div>
          </div>
        </section>
      </div>}
    </OnrampContext.Provider>
  )
}

function Status({ title, children, tone = 'neutral' }: { title: string; children: React.ReactNode; tone?: 'neutral' | 'success' | 'warning' }) {
  return <div className={`${styles.status} ${styles[`status_${tone}`]}`} role="status"><strong>{title}</strong><p>{children}</p></div>
}

export function OnrampTrigger({
  onBalanceRefresh,
  onInvoked,
  variant = 'default',
}: {
  onBalanceRefresh?: () => void
  onInvoked?: () => void
  variant?: 'default' | 'wallet' | 'walletCard' | 'header' | 'mobile' | 'insufficient'
}) {
  const context = useContext(OnrampContext)
  if (!context) throw new Error('Onramp provider missing')
  return <button type="button" className={`${styles.trigger} ${styles[`trigger_${variant}`]}`} onClick={() => {
    context.open({ onBalanceRefresh })
    onInvoked?.()
  }}>{variant === 'walletCard' ? '+ Add USDC' : 'Add USDC'}</button>
}
