'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { useAccount } from 'wagmi'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { MahsharLogo } from './MahsharLogo'
import { useVisibilityRefresh } from '@/hooks/useVisibilityRefresh'
import { useProductPreferences } from './ProductPreferencesProvider'
import { useMarketplaceSession } from './MarketplaceSessionProvider'
import styles from './nav-bar.module.css'

export function NavBar({ balanceOverride, balanceUnavailableOverride, pollBalance = true, landing = false, dashboard = false, onOnrampReturn }: { balanceOverride?: string | null; balanceUnavailableOverride?: boolean; pollBalance?: boolean; landing?: boolean; dashboard?: boolean; onOnrampReturn?: () => void }) {
  const { address, connector, isConnected } = useAccount()
  const [balance, setBalance] = useState<string | null>(null)
  const [balanceUnavailable, setBalanceUnavailable] = useState(false)
  const { formatUsdc } = useProductPreferences()
  const { request: authorizedFetch, status: sessionStatus, networkStatus, authenticate, error: sessionError } = useMarketplaceSession()
  const currentWallet = useRef<string | null>(address?.toLowerCase() ?? null)
  currentWallet.current = address?.toLowerCase() ?? null
  const inFlight = useRef(new Map<string, { promise: Promise<void>; controller: AbortController }>())

  const fetchBalance = useCallback(() => {
    if (!address || !pollBalance || sessionStatus !== 'authenticated') return Promise.resolve()
    const wallet = address.toLowerCase()
    const existing = inFlight.current.get(wallet)
    if (existing) return existing.promise
    const controller = new AbortController()
    const request = authorizedFetch(`/api/gateway/balance?wallet=${encodeURIComponent(wallet)}`, { signal: controller.signal })
        .then(r => {
          if (!r.ok) throw new Error('Gateway balance unavailable')
          return r.json()
        })
        .then((data: { gatewayAvailable?: string } | null) => {
          if (typeof data?.gatewayAvailable === 'string' && currentWallet.current === wallet) {
            setBalance(data.gatewayAvailable)
            setBalanceUnavailable(false)
          }
        })
        .catch(() => { if (currentWallet.current === wallet) setBalanceUnavailable(true) })
        .finally(() => { if (inFlight.current.get(wallet)?.promise === request) inFlight.current.delete(wallet) })
    inFlight.current.set(wallet, { promise: request, controller })
    return request
  }, [address, authorizedFetch, pollBalance, sessionStatus])
  useEffect(() => {
    setBalance(null)
    setBalanceUnavailable(false)
    const wallet = address?.toLowerCase() ?? null
    for (const [key, pending] of inFlight.current) {
      if (key !== wallet) { pending.controller.abort(); inFlight.current.delete(key) }
    }
    if (!address || !pollBalance || sessionStatus !== 'authenticated') return
    void fetchBalance()
  }, [address, pollBalance, fetchBalance, sessionStatus])
  useVisibilityRefresh(fetchBalance, !!address && pollBalance && sessionStatus === 'authenticated')
  const displayedBalance = balanceOverride === undefined ? balance : balanceOverride
  const displayedUnavailable = balanceUnavailableOverride ?? balanceUnavailable

  if (landing || dashboard) {
    return (
      <nav className={landing ? styles.landingNav : styles.dashboardNav} aria-label="Primary navigation">
        <div className={landing ? styles.landingNavInner : styles.dashboardNavInner}>
          <div className={styles.desktopHeader}>
            <div className={styles.landingNavLeft}>
              {landing && <MahsharLogo variant="landing" />}
              {!landing && <><PrimaryNavigationLink dashboard={dashboard} isConnected={isConnected} sessionStatus={sessionStatus} /><ExploreMenu /></>}
            </div>
            <HeaderControls leading={landing ? <><ExploreMenu /><PrimaryNavigationLink dashboard={false} isConnected={isConnected} sessionStatus={sessionStatus} /></> : undefined} isConnected={isConnected} displayedBalance={displayedBalance} balanceUnavailable={displayedUnavailable} formatUsdc={formatUsdc} connectorIcon={connector?.icon} sessionStatus={sessionStatus} authenticate={authenticate} sessionError={sessionError} onOnrampReturn={onOnrampReturn} />
          </div>
          <MobileHeader isConnected={isConnected} connectorIcon={connector?.icon} displayedBalance={displayedBalance} balanceUnavailable={displayedUnavailable} formatUsdc={formatUsdc} sessionStatus={sessionStatus} networkStatus={networkStatus} authenticate={authenticate} sessionError={sessionError} onOnrampReturn={onOnrampReturn} />
        </div>
      </nav>
    )
  }

  return (
    <nav className={styles.appNav} aria-label="Primary navigation">
      <div className={styles.appNavInner}>
        <div className={styles.desktopHeader}>
          <MahsharLogo variant="landing" />
          <div className={styles.appNavRight}>
            <PrimaryNavigationLink dashboard={false} isConnected={isConnected} sessionStatus={sessionStatus} />
            <ArcMainnetStatus />
            <SessionControl isConnected={isConnected} status={sessionStatus} authenticate={authenticate} error={sessionError} />
            <WalletIdentityPill connectorIcon={connector?.icon} />
          </div>
        </div>
        <MobileHeader isConnected={isConnected} connectorIcon={connector?.icon} displayedBalance={displayedBalance} balanceUnavailable={displayedUnavailable} formatUsdc={formatUsdc} sessionStatus={sessionStatus} networkStatus={networkStatus} authenticate={authenticate} sessionError={sessionError} onOnrampReturn={onOnrampReturn} />
      </div>
    </nav>
  )
}

function PrimaryNavigationLink({ dashboard, isConnected, sessionStatus }: { dashboard: boolean; isConnected: boolean; sessionStatus: 'disconnected' | 'checking' | 'signing' | 'authenticated' | 'unauthenticated' | 'error' }) {
  // Navigation is not an authorization boundary. Keep it stable while an
  // already-connected wallet is checking or completing authentication, then
  // hide it only for a disconnected or explicitly unauthenticated session.
  if (!dashboard && (!isConnected || ['disconnected', 'unauthenticated', 'error'].includes(sessionStatus))) return null
  return (
    <Link href={dashboard ? '/' : '/dashboard'} className={styles.dashboardLink} aria-label={dashboard ? 'Home' : 'Dashboard'}>
      <span className={styles.primaryLabel}>{dashboard ? 'Home' : 'Dashboard'}</span>
      {dashboard ? <HomeIcon /> : <NavArrowIcon />}
    </Link>
  )
}

function HeaderControls({ leading, isConnected, displayedBalance, balanceUnavailable, formatUsdc, connectorIcon, sessionStatus, authenticate, sessionError, onOnrampReturn }: { leading?: ReactNode; isConnected: boolean; displayedBalance: string | null; balanceUnavailable: boolean; formatUsdc: (value: string | number) => string; connectorIcon?: string; sessionStatus: 'disconnected' | 'checking' | 'signing' | 'authenticated' | 'unauthenticated' | 'error'; authenticate: () => Promise<boolean>; sessionError: string | null; onOnrampReturn?: () => void }) {
  return (
    <div className={styles.landingNavRight}>
      {leading}
      <ArcMainnetStatus />
      <SessionControl isConnected={isConnected} status={sessionStatus} authenticate={authenticate} error={sessionError} />
      <WalletIdentityPill connectorIcon={connectorIcon} />
    </div>
  )
}

function SessionControl({ isConnected, status, authenticate, error }: { isConnected: boolean; status: 'disconnected' | 'checking' | 'signing' | 'authenticated' | 'unauthenticated' | 'error'; authenticate: () => Promise<boolean>; error: string | null }) {
  if (!isConnected || status === 'authenticated' || status === 'disconnected') return null
  if (status === 'checking' || status === 'signing') {
    return <button type="button" className={`${styles.walletButton} ${styles.sessionButton}`} disabled aria-live="polite">{status === 'checking' ? 'Checking…' : 'Signing in…'}</button>
  }
  return <button type="button" className={`${styles.walletButton} ${styles.sessionButton}`} onClick={() => { void authenticate() }} title={error ?? undefined}>Sign in</button>
}

function ArcMainnetStatus() {
  return <span className={styles.networkPill} role="status" aria-label="Arc Mainnet is live"><i aria-hidden="true" />Arc Mainnet</span>
}

function WalletIdentityPill({ connectorIcon, compact = false }: { connectorIcon?: string; compact?: boolean }) {
  return (
    <ConnectButton.Custom>
      {({ account, chain, mounted, openAccountModal, openChainModal, openConnectModal }) => {
        const ready = mounted
        const connected = ready && account && chain
        if (!connected) {
          return <button type="button" className={`${styles.walletButton} ${styles.walletIdentityButton} ${compact ? styles.mobileWalletButton : ''}`} onClick={openConnectModal} disabled={!ready}>{compact ? 'Connect Wallet' : 'Connect wallet'}</button>
        }
        if (chain.unsupported) {
          return <button type="button" className={`${styles.walletButton} ${styles.walletIdentityButton} ${styles.wrongNetwork} ${compact ? styles.mobileWalletButton : ''}`} onClick={openChainModal}><span className={styles.walletMark} aria-hidden="true" />Wrong network</button>
        }
        return (
          <button type="button" className={`${styles.walletButton} ${styles.walletIdentityButton} ${compact ? styles.mobileWalletButton : ''}`} onClick={openAccountModal} aria-label={`Open account actions for ${account.address}`} title={account.address}>
            {account.ensAvatar || connectorIcon
              ? <span className={styles.walletAvatar}><img src={account.ensAvatar || connectorIcon} alt="" /></span>
              : <span className={styles.walletMark} aria-hidden="true" />}
            <span className={styles.walletAddress}>{shortEvmAddress(account.address)}</span><ChevronIcon />
          </button>
        )
      }}
    </ConnectButton.Custom>
  )
}

type SessionStatus = 'disconnected' | 'checking' | 'signing' | 'authenticated' | 'unauthenticated' | 'error'
type NetworkStatus = 'disconnected' | 'checking' | 'switching' | 'ready' | 'required'

function MobileHeader({ isConnected, connectorIcon, displayedBalance, balanceUnavailable, formatUsdc, sessionStatus, networkStatus, authenticate, sessionError, onOnrampReturn }: {
  isConnected: boolean
  connectorIcon?: string
  displayedBalance: string | null
  balanceUnavailable: boolean
  formatUsdc: (value: string | number) => string
  sessionStatus: SessionStatus
  networkStatus: NetworkStatus
  authenticate: () => Promise<boolean>
  sessionError: string | null
  onOnrampReturn?: () => void
}) {
  const pathname = usePathname()
  const [isOpen, setIsOpen] = useState(false)
  const [exploreOpen, setExploreOpen] = useState(false)
  const groupRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    setIsOpen(false)
    setExploreOpen(false)
  }, [pathname])

  useEffect(() => {
    if (!isOpen) return
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!groupRef.current?.contains(event.target as Node)) setIsOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setIsOpen(false)
      buttonRef.current?.focus()
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [isOpen])

  const close = () => {
    setIsOpen(false)
    setExploreOpen(false)
  }
  const networkCopy = networkStatus === 'switching' ? 'Switching to Arc Mainnet…'
    : networkStatus === 'required' ? 'Arc Mainnet required'
      : networkStatus === 'checking' ? 'Checking Arc Mainnet…' : 'Arc Mainnet'

  return (
    <div ref={groupRef} className={styles.mobileHeader}>
      <div className={styles.mobileTopRow}>
        <MahsharLogo variant="landing" />
        <button ref={buttonRef} type="button" className={styles.mobileMenuButton} aria-label={isOpen ? 'Close navigation menu' : 'Open navigation menu'} aria-controls="mahshar-mobile-menu" aria-expanded={isOpen} onClick={() => setIsOpen(open => !open)}>
          <span /><span /><span />
        </button>
      </div>
      <div className={styles.mobileStatusRow}>
        <span className={`${styles.mobileNetworkStatus} ${styles[`mobileNetwork_${networkStatus}`]}`} role="status" aria-label={networkCopy} title={networkCopy}><i aria-hidden="true" /><span>Arc Mainnet</span></span>
        <WalletIdentityPill connectorIcon={connectorIcon} compact />
      </div>
      {isOpen && <>
        <button type="button" className={styles.mobileMenuScrim} aria-label="Close navigation menu" onClick={close} />
        <div id="mahshar-mobile-menu" className={styles.mobileMenuPanel} aria-label="Mobile navigation">
          <div className={styles.mobileMenuSection}>
            <button type="button" className={styles.mobileExploreToggle} aria-expanded={exploreOpen} aria-controls="mahshar-mobile-explore" onClick={() => setExploreOpen(open => !open)}><span>Explore</span><ChevronIcon /></button>
            {exploreOpen && <div id="mahshar-mobile-explore" className={styles.mobileExploreLinks}>
              <MobileMenuLink href="/marketplace" onSelect={close}>Marketplace</MobileMenuLink>
              <MobileMenuLink href="/seller" onSelect={close}>Build</MobileMenuLink>
              <MobileMenuLink href="/agents" onSelect={close}>Agents</MobileMenuLink>
              <MobileMenuLink href="/docs" onSelect={close}>Docs</MobileMenuLink>
            </div>}
          </div>
          <MobileMenuLink href="/dashboard" onSelect={close}>Dashboard</MobileMenuLink>
          <div className={styles.mobileMenuStatus}><span>Arc Mainnet</span><strong className={styles[`mobileMenuNetwork_${networkStatus}`]}>{networkCopy}</strong></div>
          <MobileMenuLink href="/dashboard/wallet" onSelect={close}>Wallet</MobileMenuLink>
          <MobileMenuLink href="/dashboard/settings" onSelect={close}>Settings</MobileMenuLink>
          <MobileMenuLink href="/support" onSelect={close}>Support</MobileMenuLink>
          {isConnected && sessionStatus !== 'authenticated' && sessionStatus !== 'disconnected' && <div className={styles.mobileSessionState}>
            <p aria-live="polite">{sessionStatus === 'signing' ? 'Signing in…' : sessionStatus === 'checking' ? 'Checking session…' : sessionError ?? 'Sign in to use private features.'}</p>
            {['unauthenticated', 'error'].includes(sessionStatus) && <button type="button" onClick={() => { void authenticate() }}>Sign in</button>}
          </div>}
        </div>
      </>}
    </div>
  )
}

function MobileMenuLink({ href, children, detail, onSelect }: { href: string; children: ReactNode; detail?: string; onSelect: () => void }) {
  return <Link href={href} className={styles.mobileMenuLink} onClick={onSelect}><span>{children}</span>{detail && <small>{detail}</small>}<NavArrowIcon /></Link>
}

function shortEvmAddress(address: string) {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address
}

function ExploreMenu() {
  const [isOpen, setIsOpen] = useState(false)
  const groupRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!isOpen) return

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!groupRef.current?.contains(event.target as Node)) setIsOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setIsOpen(false)
      buttonRef.current?.focus()
    }

    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [isOpen])

  return (
    <div
      ref={groupRef}
      className={styles.exploreGroup}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setIsOpen(false)
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className={styles.exploreButton}
        aria-haspopup="menu"
        aria-controls="landing-explore-menu"
        aria-expanded={isOpen}
        onClick={() => setIsOpen(open => !open)}
      >
        Explore <ChevronIcon />
      </button>
      {isOpen && (
        <div id="landing-explore-menu" className={styles.exploreMenu} role="menu">
          <ExploreLink href="/marketplace" title="Marketplace" copy="Browse active APIs" icon={<MarketplaceIcon />} onSelect={() => setIsOpen(false)} />
          <ExploreLink href="/agents" title="Agents" copy="Use the machine interface" icon={<AgentIcon />} onSelect={() => setIsOpen(false)} />
          <ExploreLink href="/docs" title="Docs" copy="Read Mahshar documentation" icon={<DocsIcon />} onSelect={() => setIsOpen(false)} />
          <ExploreLink href="/support" title="Support" copy="Get product help" icon={<SupportIcon />} onSelect={() => setIsOpen(false)} />
        </div>
      )}
    </div>
  )
}

function ExploreLink({ href, title, copy, icon, onSelect }: { href: string; title: string; copy: string; icon: React.ReactNode; onSelect: () => void }) {
  return <Link href={href} className={styles.exploreItem} role="menuitem" onClick={onSelect}><span className={styles.exploreIcon}>{icon}</span><span><strong>{title}</strong><small>{copy}</small></span></Link>
}

function NavArrowIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5" /></svg> }
function HomeIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 11 8-7 8 7" /><path d="M6.5 10v10h11V10M10 20v-6h4v6" /></svg> }
function ChevronIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 7.5 5 5 5-5" /></svg> }
function AgentIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="7" width="14" height="12" rx="3" /><path d="M12 3v4M9 12h.01M15 12h.01M2 12h3M19 12h3" /></svg> }
function MarketplaceIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h16l-1-4H5L4 8Z" /><path d="M5 8v12h14V8M9 20v-6h6v6" /></svg> }
function DocsIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h9l4 4v14H6V3Z" /><path d="M15 3v5h4M9 12h6M9 16h6" /></svg> }
function SupportIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M9.8 9a2.4 2.4 0 1 1 3.2 2.27c-.62.25-1 .88-1 1.55V14M12 18h.01" /></svg> }
