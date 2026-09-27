'use client'

import { Arc, type EstimateResult } from '@circle-fin/bridge-kit'
import { useBridgeJourney } from './useBridgeJourney'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import Link from 'next/link'
import Image from 'next/image'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useDashboardWorkspace } from '../../dashboard-workspace'
import { DashboardCardHeader, DashboardIcon, UsdcUnit } from '../../dashboard-visuals'
import { MahsharFlowMotif } from '@/components/MahsharFlowMotif'
import { amountIssue, balanceValue, bridgeEstimateDetails, bridgeStepName, bridgeStepStatus, distribution, progressStages, shortTransactionHash, transactionLinks, type BalanceRow } from './presentation'
import dashboardStyles from '../../dashboard.module.css'
import styles from './bridge.module.css'
import { chainLogoPath } from './chain-logos'
import { bridgeErrorMessage, circleFeeIssue } from '@/lib/bridge-journey-state'
import { sendLocalNotification, useProductPreferences } from '@/components/ProductPreferencesProvider'
import { BridgeAmountControl } from './BridgeAmountControl'

const COLORS = ['#9fc8f1', '#addfc4', '#c6b6ec', '#efb9cb', '#f0d197', '#bdcbdc']
const STAGES = ['Approve USDC', 'Initiate Bridge', 'Circle bridging transaction', 'Receive on Arc']
const PANEL_TONES = { blue: styles.panelBlue, green: styles.panelGreen, purple: styles.panelPurple, pink: styles.panelPink }
function PanelHeader({ tone, children }: { tone: keyof typeof PANEL_TONES; children: ReactNode }) {
  return <div className={`${styles.heading} ${styles.panelHeader} ${PANEL_TONES[tone]}`}><MahsharFlowMotif variant="card" tone={tone} className={styles.panelMotif} />{children}</div>
}
function shortAddress(value: string) { return `${value.slice(0,6)}…${value.slice(-4)}` }
function sixDecimals(value: string) {
  const [whole, fraction = ''] = value.split('.')
  return `${whole}.${fraction.padEnd(6,'0').slice(0,6)}`
}
function ChainIcon({ chain }: { chain: string }) {
  const logo = chainLogoPath(chain)
  return <span className={styles.chainIcon} aria-hidden="true">{logo && <Image src={logo} alt="" width={28} height={28} unoptimized />}</span>
}
function Updated({ updatedAt, ready, loading = false }: { updatedAt: number | null; ready: boolean; loading?: boolean }) {
  const [now, setNow] = useState(0)
  useEffect(() => { if (updatedAt) setNow(Date.now()) }, [updatedAt])
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, [])
  return <small className={styles.updated} title="Time since this balance snapshot was received by this page">{loading ? 'Refreshing balances…' : !ready || updatedAt === null ? 'Waiting for balances' : `Updated ${Math.max(0, Math.floor((now-updatedAt)/1000))}s ago`}</small>
}
function Balance({ row }: { row?: BalanceRow }) {
  const { preferences, formatUsdc } = useProductPreferences()
  if (!row || row.loading) return <span className={styles.skeleton} aria-label="Loading balance" />
  const value = balanceValue(row)
  const hidden = !preferences.showSmallBalances && value !== null && value > BigInt(0) && value < BigInt(10_000)
  return <span>{row.disconnected ? 'Connect wallet' : value === null ? 'Unavailable' : hidden ? 'Small balance hidden' : `${formatUsdc(value, true)} USDC`}</span>
}

export default function BridgeDashboardPage() {
  const { isConnected, address, circleBridge, scheduleWalletRefresh, balanceUpdatedAt, walletUsdcRaw, gatewayStats, bridgeBalances, solanaConnected, solanaBalance } = useDashboardWorkspace()
  const { preferences, formatUsdc } = useProductPreferences()
  const [selectedSource, setSelectedSource] = useState('')
  const [amount, setAmount] = useState('')
  const [open, setOpen] = useState(false)
  const sourceChosenByUser = useRef(false)
  const [quote, setQuote] = useState<{ key: string; value: EstimateResult } | null>(null)
  const [estimating, setEstimating] = useState(false)
  const [quoteError, setQuoteError] = useState<string | null>(null)
  const [viewAll, setViewAll] = useState(false)
  const journey = useBridgeJourney(circleBridge, scheduleWalletRefresh)
  const quoteKey = `${address}:${selectedSource}:${amount}:${circleBridge.catalog?.routes.find(route => route.source.chain === selectedSource)?.useForwarder}`
  const currentQuoteKey = useRef(quoteKey); currentQuoteKey.current = quoteKey
  const currentQuote = quote?.key === quoteKey ? quote.value : null
  const estimateDetails = bridgeEstimateDetails(currentQuote)
  useEffect(() => { setQuoteError(null); setEstimating(false) }, [quoteKey])
  useEffect(() => () => { currentQuoteKey.current = '' }, [])
  async function requestEstimate() {
    const key = quoteKey
    setEstimating(true); setQuoteError(null)
    try {
      const value = await circleBridge.estimate(selectedSource, amount)
      if (currentQuoteKey.current === key) setQuote({ key, value })
    } catch (error) {
      if (currentQuoteKey.current === key) { setQuote(null); setQuoteError(bridgeErrorMessage(error)) }
    } finally { if (currentQuoteKey.current === key) setEstimating(false) }
  }
  const dropdown = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const portfolioRoutes = circleBridge.catalog?.routes
  const routes = useMemo(() => portfolioRoutes?.filter(route => route.source.type === 'evm'), [portfolioRoutes])
  const selectedRoute = routes?.find(route => route.source.chain === selectedSource)
  useEffect(() => {
    if (routes && !routes.some(route => route.source.chain === selectedSource)) setSelectedSource(routes[0]?.source.chain ?? '')
  }, [routes, selectedSource])
  const notifiedActivity = useRef<string | null>(null)
  useEffect(() => {
    const active = journey.active
    const notification = active?.result?.state === 'success' ? `${active.id}:bridge-success` : active?.result?.state === 'error' || (active && !active.result && active.deposit === 'unavailable') ? `${active.id}:bridge-failed` : null
    if (!active || !notification || notifiedActivity.current === notification) return
    if (notification.endsWith('success') && preferences.notifications.bridgeCompleted) {
      sendLocalNotification('Bridge completed', `${active.receivedAmount ?? active.amount} USDC reached your Arc Mainnet wallet.`)
      notifiedActivity.current = notification
    } else if (notification.endsWith('failed') && preferences.notifications.bridgeFailed) {
      sendLocalNotification('Bridge needs attention', active.error ?? 'The bridge failed. Review Bridge Progress.')
      notifiedActivity.current = notification
    }
  }, [journey.active, preferences.notifications.bridgeCompleted, preferences.notifications.bridgeFailed])
  useEffect(() => {
    if (!open) return
    const option = dropdown.current?.querySelector<HTMLButtonElement>('[role="option"][aria-selected="true"]') ?? dropdown.current?.querySelector<HTMLButtonElement>('[role="option"]')
    option?.focus()
    const close = (event: PointerEvent) => { if (!dropdown.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [open])
  const portfolioRows = useMemo<BalanceRow[]>(() => (portfolioRoutes ?? []).map(({ source }) => {
    const balance = source.type === 'solana' ? solanaBalance : bridgeBalances.find(item => item.chainName === source.chain)
    return { key: source.chain, name: source.name, balance: balance?.usdcBalance ?? '?', loading: source.type === 'solana' && !solanaConnected ? false : !balance || balance.isLoading, disconnected: source.type === 'solana' && !solanaConnected }
  }).sort((a,b) => {
    if (!preferences.fundedChainsFirst) return a.name.localeCompare(b.name)
    const av = balanceValue(a) ?? BigInt(0), bv = balanceValue(b) ?? BigInt(0)
    return av === bv ? a.name.localeCompare(b.name) : av > bv ? -1 : 1
  }), [portfolioRoutes, bridgeBalances, solanaBalance, solanaConnected, preferences.fundedChainsFirst])
  const rows = useMemo(() => portfolioRows.filter(row => routes?.some(route => route.source.chain === row.key)), [portfolioRows, routes])
  useEffect(() => {
    if (sourceChosenByUser.current || amount) return
    const firstFunded = rows.find(row => (balanceValue(row) ?? BigInt(0)) > BigInt(0))
    if (firstFunded && firstFunded.key !== selectedSource) setSelectedSource(firstFunded.key)
  }, [rows, amount, selectedSource])
  const chart = useMemo(() => distribution(portfolioRows), [portfolioRows])
  const selected = rows.find(row => row.key === selectedSource)
  const available = selected ? balanceValue(selected) : null
  const validationIssue = amountIssue(amount, available)
  const issue = validationIssue ?? circleFeeIssue(amount, currentQuote)
  const busy = circleBridge.isLoading || journey.working
  const canBridge = isConnected && !!selectedRoute && !!amount && !issue && available !== null && !busy && !circleBridge.pending && (circleBridge.adapterReady?.(selectedSource) ?? true) && !(selectedRoute.source.type === 'solana' && !solanaConnected)
  const loadingBalances = !portfolioRoutes || portfolioRows.some(row => row.loading)
  let offset = 0
  const gradient = chart.slices.map((slice,index) => {
    const start = offset; offset += Number(slice.value) / Number(chart.total) * 100
    return `${COLORS[index]} ${start}% ${offset}%`
  }).join(', ')
  const result = circleBridge.result
  const links = transactionLinks(result, circleBridge.liveSteps, result?.source.chain ?? selectedRoute?.source, Arc)
  const recordedStepLinks = transactionLinks(result)
  const stages = progressStages(result, circleBridge.isLoading, circleBridge.stepLabel, circleBridge.error, circleBridge.liveSteps)
  const activeJourney = result && journey.active?.result?.state === result.state
    && journey.active.result.source.chain.chain === result.source.chain.chain
    && journey.active.result.amount === result.amount ? journey.active : null
  const activity = journey.activity.length ? journey.activity : result ? [{ id: 'restored', date: '', source: result.source.chain.name, amount: result.amount, result, deposit: 'pending' as const }] : []
  const depositLink = (hash: string) => Arc.explorerUrl.replace('{hash}', encodeURIComponent(hash))
  const card = dashboardStyles.card

  return <div className={dashboardStyles.content}>
    <div className={styles.page}>
    <header className={`${dashboardStyles.pageHeader} ${styles.pageHeader}`}>
      <div><p className={dashboardStyles.eyebrow}>MOVE USDC TO ARC MAINNET</p><h1>Bridge</h1><p>Bridge USDC from supported EVM chains into your connected Arc Mainnet wallet.</p></div>
    </header>
    {!isConnected ? <section className={`${card} ${styles.empty}`}><DashboardIcon name="wallet" /><h2>Connect your wallet</h2><p>View balances and Circle-supported USDC routes to Arc Mainnet.</p><ConnectButton /></section> : <>
      <section className={styles.summaryGrid} aria-label="Bridge balance summary">
        <article className={card}><DashboardCardHeader title="Arc Wallet USDC" subtitle="USDC in your Arc wallet" icon="wallet" tone="blue" /><div className={styles.summaryValue}>{walletUsdcRaw === undefined ? <span className={styles.skeleton} /> : formatUsdc(walletUsdcRaw, true)} <UsdcUnit /></div><Updated updatedAt={balanceUpdatedAt} ready={walletUsdcRaw !== undefined} /></article>
        <article className={card}><DashboardCardHeader title="Total USDC Across Chains" subtitle="Circle-supported source wallets" icon="bank" tone="green" /><div className={styles.summaryValue}>{routes ? formatUsdc(chart.total, true) : <span className={styles.skeleton} />} <UsdcUnit /></div>{(chart.partial || !routes) && <p className={styles.muted}>Partial · known balances only</p>}<div className={styles.summaryFooter}><Updated updatedAt={balanceUpdatedAt} ready={!!routes} loading={loadingBalances} /></div></article>
        <article className={`${card} ${styles.destinationCard}`}><DashboardCardHeader title="Destination" subtitle="Fixed destination" icon="bridge" tone="purple" /><div className={styles.destinationTitle}>Arc Mainnet</div><p className={styles.muted}>Your connected Arc wallet</p></article>
        <article className={card}><DashboardCardHeader title="Mahshar Balance" subtitle="Available for paid APIs" icon="balance" tone="pink" /><div className={styles.summaryValue}>{gatewayStats ? formatUsdc(gatewayStats.gatewayAvailable) : <span className={styles.skeleton} />} <UsdcUnit /></div><Updated updatedAt={balanceUpdatedAt} ready={!!gatewayStats} /></article>
      </section>
      <div className={styles.workspaceGrid}>
        <div className={styles.workspaceStack}>
          <section className={`${card} ${styles.form}`}>
          <PanelHeader tone="blue"><h2>Bridge USDC</h2><span className={styles.powered}>Powered by Circle</span></PanelHeader>
          <p className={styles.intro}>Transfer your USDC from any supported chain to Arc using Circle&apos;s secure infrastructure.</p>
          <div className={styles.field}>
            <label id="source-label"><span className={styles.stepNumber}>1</span>Choose source chain</label>
            <div ref={dropdown} className={styles.dropdown} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false) }} onKeyDown={event => {
              if (event.key === 'Escape') { setOpen(false); trigger.current?.focus() }
              if (['ArrowDown','ArrowUp'].includes(event.key)) {
                event.preventDefault(); setOpen(true)
                const buttons = Array.from(dropdown.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])
                const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
                if (buttons.length) buttons[index < 0 ? (event.key === 'ArrowDown' ? 0 : buttons.length - 1) : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
              }
            }}>
              <button ref={trigger} type="button" className={styles.selector} aria-labelledby="source-label source-value" aria-haspopup="listbox" aria-expanded={open} aria-controls="source-options" disabled={busy || !rows.length} onClick={() => setOpen(!open)}>
                <ChainIcon chain={selected?.key ?? ''} /><strong id="source-value">{selected?.name ?? (routes ? 'No routes available' : 'Loading routes…')}</strong><Balance row={selected} /><span aria-hidden="true">⌄</span>
              </button>
              {open && <div id="source-options" role="listbox" aria-labelledby="source-label" className={styles.options}>{rows.map(row => <button type="button" key={row.key} role="option" aria-selected={row.key === selectedSource} onClick={() => { sourceChosenByUser.current = true; setSelectedSource(row.key); setOpen(false); trigger.current?.focus() }}><ChainIcon chain={row.key} /><strong>{row.name}</strong><Balance row={row} /></button>)}</div>}
            </div>
            {routes?.length === 0 && <p role="status" className={styles.warning}>No Circle-confirmed routes are available. Refresh to check again.</p>}
          </div>
          <div className={styles.field}>
            <label htmlFor="bridge-amount"><span className={styles.stepNumber}>2</span>Enter amount</label>
            <BridgeAmountControl id="bridge-amount" value={amount} onChange={setAmount} onMax={() => setAmount(selected!.balance)} unit={<UsdcUnit />} disabled={busy} maxDisabled={busy || available === null || available === BigInt(0)} invalid={!!issue} describedBy="source-balance amount-error" />
            <p id="source-balance" className={styles.muted}>Source chain balance: <Balance row={selected} /></p>
            <p id="amount-error" role={issue ? 'alert' : undefined} className={styles.error}>{issue}</p>
          </div>
          <div className={styles.field}>
            <label><span className={styles.stepNumber}>3</span>Destination</label>
            <div className={styles.destination}><ChainIcon chain="Arc" /><div><strong>Arc Mainnet</strong></div><code title={address}>{address ? shortAddress(address) : '—'}</code></div>
            <p className={styles.muted}>The bridge is complete when USDC reaches this Arc wallet. Depositing to Mahshar Balance is a separate optional action.</p>
          </div>
          <button type="button" className={styles.textButton} disabled={!canBridge || estimating} onClick={() => void requestEstimate()}>{estimating ? 'Getting Circle estimate…' : 'Get Circle estimate ↻'}</button>{quoteError && <p className={styles.error} role="alert">{quoteError}</p>}<p className={styles.muted}>Circle estimates dynamic CCTP and forwarding fees plus source-chain gas reserves. Estimates may change before execution and do not sign or submit a transaction.</p>
          <button type="button" className={styles.primary} disabled={!canBridge} onClick={() => {
            if (window.confirm(`Bridge ${amount} USDC from ${selected?.name} to your Arc Mainnet wallet ${address}? Circle fees apply. ${selectedRoute?.useForwarder ? 'Circle forwards the transfer.' : 'Your Arc wallet will sign the destination mint and needs USDC for gas.'} This moves real USDC.`)) void journey.start(selectedSource, amount)
          }}>{journey.bridging || circleBridge.isLoading ? circleBridge.stepLabel : 'Bridge to Arc'}</button>
          <p className={styles.footnote}>USDC only · Your connected wallet is always the recipient</p>
          </section>
          <section className={card}><PanelHeader tone="pink"><h2>Route Summary</h2></PanelHeader><dl className={styles.details}>
            <div><dt>Route</dt><dd>{selected?.name ?? 'Source chain'} → Arc Mainnet</dd></div>
            <div><dt>You send</dt><dd>{amount && !validationIssue ? `${amount} USDC` : '—'}</dd></div>
            <div><dt>Recipient</dt><dd><code title={address}>{address ? shortAddress(address) : '—'}</code></dd></div>
            <div><dt>Transfer mode</dt><dd>CCTP v2 · FAST</dd></div>
            <div><dt>Delivery</dt><dd>{selectedRoute?.useForwarder ? 'Circle Forwarding Service' : selectedRoute ? 'Destination wallet mint' : '—'}</dd></div>
            <div><dt>Route status</dt><dd>{selectedRoute ? 'Supported by Circle Bridge Kit' : 'Checking route support…'}</dd></div>
            {estimateDetails?.providerFee && <div><dt>CCTP/provider fee</dt><dd>{estimateDetails.providerFee}</dd></div>}
            {estimateDetails?.forwardingFee && <div><dt>Forwarding fee</dt><dd>{estimateDetails.forwardingFee}</dd></div>}
            {estimateDetails?.approvalGasReserve && <div><dt>Source-chain approval gas reserve</dt><dd>{estimateDetails.approvalGasReserve}</dd></div>}
            {estimateDetails?.burnGasReserve && <div><dt>Source-chain burn gas reserve</dt><dd>{estimateDetails.burnGasReserve}</dd></div>}
            {currentQuote && selectedRoute?.useForwarder && <div><dt>Destination mint gas</dt><dd>Paid and submitted by Circle</dd></div>}
          </dl>
            {currentQuote && <p className={styles.valid}>✓ Estimate retrieved successfully.</p>}
            {!selectedRoute && <p className={styles.warning}>Waiting for a Circle-supported route.</p>}
          </section>
        </div>
        <div className={styles.workspaceStack}>
          <section className={card}>
            <PanelHeader tone="green"><h2>USDC Distribution Across Chains</h2></PanelHeader><p className={styles.total}>Total <strong>{formatUsdc(chart.total, true)} USDC</strong></p>
            <div className={styles.distributionBody}>
              <div className={styles.donut} style={{ background: gradient ? `conic-gradient(${gradient})` : '#edf1f6' }} role="img" aria-label={`Known source-chain USDC total ${formatUsdc(chart.total, true)}; detailed balances below`}><div><strong>{formatUsdc(chart.total, true)}</strong><UsdcUnit /></div></div>
              <ul className={styles.legend}>{chart.slices.filter(slice => preferences.showSmallBalances || slice.value >= BigInt(10_000)).map((slice,index) => <li key={slice.name}><span className={styles.dot} style={{ background: COLORS[index] }} /><span title={slice.name}>{slice.name}</span><strong>{formatUsdc(slice.value, true)}</strong><small>{(Number(slice.value) / Number(chart.total) * 100).toFixed(1)}%</small></li>)}</ul>
            </div>
            {!chart.slices.length && <p className={styles.footnote}>{loadingBalances ? 'Loading chain balances…' : 'No funded source wallets detected.'}</p>}
            {chart.partial && <p className={styles.muted}>Unknown and disconnected balances excluded. Arc wallet and Mahshar Balance are separate.</p>}<Updated updatedAt={balanceUpdatedAt} ready={!!routes} loading={loadingBalances} />
          </section>
          <section className={card} id="bridge-progress"><PanelHeader tone="purple"><h2>Bridge Progress</h2><span className={result?.state === 'success' ? styles.valid : result?.state === 'error' ? styles.error : styles.badge}>{result?.state === 'success' ? 'Success' : result?.state ?? (circleBridge.isLoading ? 'In progress' : 'Ready')}</span></PanelHeader><p className={styles.intro}>Track the Circle bridge into your Arc wallet in real time.</p>
        <ol className={styles.stages}>{STAGES.map((label,index) => <li key={label} className={styles[stages[index]]} aria-current={stages[index] === 'current' ? 'step' : undefined}><span>{stages[index] === 'completed' ? '✓' : index+1}</span><strong>{label}</strong><small>{stages[index]}</small></li>)}</ol>
        <div role="status" className={styles.status}><strong>{result?.state === 'success' ? 'Received on Arc' : circleBridge.stepLabel}</strong><p>{result?.state === 'success' ? activeJourney?.receivedAmount ? `${sixDecimals(activeJourney.receivedAmount)} USDC` : 'USDC is confirmed in your Arc wallet.' : 'Stages reflect the latest Circle SDK information. Detailed approval and mint status appears when Circle returns it.'}</p></div>
        {circleBridge.error && <p role="alert" className={styles.error}>{circleBridge.error}</p>}{circleBridge.recoveryNotice && <p role="status" className={styles.warning}>{circleBridge.recoveryNotice}</p>}
        <div className={styles.actions}>{links.map(link => <a key={link.step+link.hash} href={link.href} target="_blank" rel="noopener noreferrer">{link.label} · {link.step} ↗</a>)}
          {result && circleBridge.resumable && <button type="button" className={styles.secondary} disabled={circleBridge.isLoading} onClick={() => { if (window.confirm(`Resume the existing ${result.amount} USDC transfer to ${address} on Arc Mainnet using Circle's saved result?`)) void circleBridge.retry().then(retried => { if (retried?.state === 'success') scheduleWalletRefresh({ kind: 'bridge', source: retried.source.chain.type === 'solana' ? 'solana' : 'evm' }) }) }}>Resume with Circle</button>}
          {result?.state === 'error' && !circleBridge.resumable && <button type="button" className={styles.textButton} onClick={circleBridge.reset}>New transfer</button>}
          {result?.state === 'success' && !journey.bridging && <button className={styles.textButton} onClick={circleBridge.reset}>New transfer</button>}
        </div>
        {result?.state === 'success' && <div className={styles.depositPanel} aria-label="Optional Mahshar deposit">
          <div><h3>Mahshar Deposit <span>Optional</span></h3><p>The bridge is complete. Move the measured Arc receipt into Mahshar Balance only if you choose.</p></div>
          {activeJourney?.deposit === 'available' && activeJourney.receivedAmount ? <button type="button" className={styles.secondary} disabled={journey.depositing} onClick={() => {
            if (window.confirm(`Deposit ${sixDecimals(activeJourney.receivedAmount!)} USDC from your Arc wallet to Mahshar Balance? This is a separate transaction and requires wallet confirmation.`)) void journey.deposit()
          }}>Deposit to Mahshar Balance</button> : activeJourney?.deposit === 'current' ? <strong>Confirming Gateway deposit…</strong> : activeJourney?.deposit === 'completed' ? <strong className={styles.valid}>{sixDecimals(activeJourney.depositedAmount ?? activeJourney.receivedAmount ?? result.amount)} USDC deposited</strong> : <Link className={styles.secondary} href="/dashboard/wallet">Review deposit in Wallet →</Link>}
          {activeJourney?.depositHash && <a href={depositLink(activeJourney.depositHash)} target="_blank" rel="noopener noreferrer">Arc · Gateway deposit ↗</a>}
          {activeJourney?.deposit === 'failed' && <p role="alert" className={styles.error}>{activeJourney.error ?? 'The optional deposit needs review. The bridge remains successful.'}</p>}
          {activeJourney?.deposit === 'unavailable' && <p role="status" className={styles.warning}>{activeJourney.error ?? 'The bridge remains successful, but this receipt cannot be safely deposited automatically.'}</p>}
          {journey.error && activeJourney?.deposit !== 'failed' && activeJourney?.deposit !== 'unavailable' && <p role="alert" className={styles.error}>{journey.error}</p>}
        </div>}
        {circleBridge.technicalError && circleBridge.technicalError !== circleBridge.error && <details><summary>Technical details</summary><pre className={styles.recorded}>{circleBridge.technicalError}</pre></details>}
        {circleBridge.pending && result?.state !== 'success' && <p className={styles.warning}>If funds have moved, do not start a new transfer. Review or resume the existing Circle bridge.</p>}
          </section>
        </div>
      </div>
      <section className={`${card} ${styles.recent}`}><PanelHeader tone="pink"><h2>Recent bridge activity</h2>{activity.length > 0 && <button type="button" className={styles.textButton} onClick={() => setViewAll(!viewAll)}>{viewAll ? 'Show recent' : 'View all →'}</button>}</PanelHeader><p className={styles.intro}>Recorded bridge and deposit activity on this device. Records are scoped to your connected wallet.</p>
        {journey.storageError && <p role="status" className={styles.warning}>{journey.storageError}</p>}
        <div className={styles.tableWrap}><table><caption className={styles.srOnly}>Recorded Circle bridge activity</caption><thead><tr>{['Date','From → To','Amount','Status','Explorer'].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead><tbody>{activity.length ? activity.slice(0,viewAll ? 100 : 5).map(item => <tr key={item.id}><td>{item.date ? new Date(item.date).toLocaleString() : 'Not recorded'}</td><td>{item.result?.source.chain.name ?? item.source} → Arc</td><td>{item.amount} USDC</td><td><span className={item.result?.state === 'success' ? styles.valid : item.result?.state === 'error' || (!item.result && item.deposit === 'unavailable') ? styles.error : styles.badge}>{item.result?.state === 'success' ? 'Completed' : item.result?.state === 'error' || (!item.result && item.deposit === 'unavailable') ? 'Failed' : 'In progress'}</span>{item.result?.state === 'success' && <small className={styles.updated}>Arc received · deposit {item.deposit === 'completed' ? 'completed' : item.deposit === 'current' ? 'in progress' : item.deposit === 'failed' || item.deposit === 'unavailable' ? 'needs review' : 'optional'}</small>}</td><td>{transactionLinks(item.result ?? null).map(link => <a key={link.step+link.hash} href={link.href} target="_blank" rel="noopener noreferrer">{link.label} · {link.step} ↗ </a>)}{item.depositHash && <a href={depositLink(item.depositHash)} target="_blank" rel="noopener noreferrer">Arc · Deposit ↗</a>}{!item.result && 'Not available'}</td></tr>) : <tr><td colSpan={5} className={styles.emptyRow}>{circleBridge.pending ? 'A saved submission needs review. See Bridge Progress.' : 'No recorded bridge activity yet.'}</td></tr>}</tbody></table></div>
      </section>
      {result && <details id="recorded-steps" className={`${card} ${styles.technicalDetails}`}>
        <summary className={styles.technicalSummary}>
          <MahsharFlowMotif variant="card" tone="blue" className={styles.technicalMotif} />
          <span className={styles.technicalHeading}><span className={styles.technicalTitle} role="heading" aria-level={2}>Technical Details</span><span className={styles.technicalSubtitle}>Detailed execution steps for this bridge transaction.</span></span>
          <span className={styles.technicalControl}><span className={styles.technicalViewLabel}>View technical details</span><span className={styles.technicalHideLabel}>Hide technical details</span><span className={styles.technicalChevron} aria-hidden="true">⌄</span></span>
        </summary>
        <div className={styles.technicalBody}>
          <ol className={styles.technicalSteps}>
            {result.steps.map((step,index) => {
              const stepName = bridgeStepName(step.name)
              const explorer = step.txHash ? recordedStepLinks.find(link => link.hash === step.txHash && link.step === step.name) : undefined
              const statusClass = ({ success: styles.technicalStatusCompleted, error: styles.technicalStatusFailed, failed: styles.technicalStatusFailed, noop: styles.technicalStatusOptional, pending: styles.technicalStatusPending } as Record<string, string>)[step.state] ?? styles.technicalStatusPending
              return <li key={`${step.name}-${index}`} className={styles.technicalStep}>
                <span className={styles.technicalNode} aria-hidden="true" />
                <strong>{stepName}</strong>
                <span className={`${styles.technicalStatus} ${statusClass}`}>{bridgeStepStatus(step.state)}</span>
                <div className={styles.technicalTransaction}>
                  {step.txHash && (explorer
                    ? <a href={explorer.href} target="_blank" rel="noopener noreferrer" title={step.txHash} aria-label={`View ${stepName} transaction ${step.txHash} on explorer`}><code>{shortTransactionHash(step.txHash)}</code><span>View on Explorer ↗</span></a>
                    : <code title={step.txHash} aria-label={`Transaction hash ${step.txHash}`}>{shortTransactionHash(step.txHash)}</code>)}
                </div>
                {step.errorMessage && <details className={styles.technicalError}><summary>Error details</summary><p>{step.errorMessage}</p></details>}
              </li>
            })}
          </ol>
        </div>
      </details>}
    </>}
    </div>
  </div>
}
