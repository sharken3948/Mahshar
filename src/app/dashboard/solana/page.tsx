'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { Arc, Blockchain, BridgeChain, type EstimateResult } from '@circle-fin/bridge-kit'
import { DashboardCardHeader, DashboardIcon, UsdcUnit } from '../dashboard-visuals'
import { useDashboardWorkspace } from '../dashboard-workspace'
import { sendLocalNotification, useProductPreferences } from '@/components/ProductPreferencesProvider'
import { bridgeErrorMessage, circleFeeIssue } from '@/lib/bridge-journey-state'
import { useBridgeJourney } from '../wallet/bridge/useBridgeJourney'
import { amountIssue, bridgeEstimateDetails, progressStages, transactionLinks, units } from '../wallet/bridge/presentation'
import dashboardStyles from '../dashboard.module.css'
import bridgeStyles from '../wallet/bridge/bridge.module.css'
import styles from './solana.module.css'
import { BridgeAmountControl } from '../wallet/bridge/BridgeAmountControl'

const STAGES = ['Approve USDC', 'Initiate Bridge', 'Circle bridging transaction', 'Receive on Arc']
function shortAddress(value: string) { return `${value.slice(0,8)}…${value.slice(-8)}` }
function shortEvmAddress(value: string) { return `${value.slice(0,6)}…${value.slice(-4)}` }
function sixDecimals(value: string) {
  const [whole, fraction = ''] = value.split('.')
  return `${whole}.${fraction.padEnd(6,'0').slice(0,6)}`
}

export default function SolanaDashboardPage() {
  const {
    isConnected, address, circleBridge, scheduleWalletRefresh, solanaPubkey,
    solanaConnected, solanaDisconnect, setSolanaModalVisible, solanaBalance,
  } = useDashboardWorkspace()
  const { preferences } = useProductPreferences()
  const [amount, setAmount] = useState('')
  const [quote, setQuote] = useState<{ key: string; value: EstimateResult } | null>(null)
  const [estimating, setEstimating] = useState(false)
  const [quoteError, setQuoteError] = useState<string | null>(null)
  const journey = useBridgeJourney(circleBridge, scheduleWalletRefresh)
  const connectedAddress = solanaPubkey?.toBase58()
  const route = circleBridge.catalog?.routes.find(item => item.source.chain === Blockchain.Solana)
  const quoteKey = `${address}:${connectedAddress}:${amount}:${route?.useForwarder}`
  const currentQuoteKey = useRef(quoteKey); currentQuoteKey.current = quoteKey
  const currentQuote = quote?.key === quoteKey ? quote.value : null
  const estimateDetails = bridgeEstimateDetails(currentQuote)
  const available = solanaConnected && connectedAddress && !solanaBalance.isLoading ? units(solanaBalance.usdcBalance) : null
  const issue = amountIssue(amount, available) ?? circleFeeIssue(amount, currentQuote)
  const result = circleBridge.result?.source.chain.chain === Blockchain.Solana ? circleBridge.result : null
  const activeJourney = journey.active?.result?.state === 'success'
    && journey.active.result.source.chain.chain === Blockchain.Solana ? journey.active : null
  const stages = progressStages(result, circleBridge.isLoading, circleBridge.stepLabel, circleBridge.error, circleBridge.liveSteps)
  const links = transactionLinks(result, circleBridge.liveSteps, route?.source, Arc)
  const canBridge = Boolean(isConnected && address && route && solanaConnected && connectedAddress && amount && !issue
    && available !== null && !journey.working && !circleBridge.isLoading && !circleBridge.pending
    && (circleBridge.adapterReady?.(BridgeChain.Solana) ?? true))
  const notified = useRef<string | null>(null)

  useEffect(() => { setQuoteError(null); setEstimating(false) }, [quoteKey])
  useEffect(() => () => { currentQuoteKey.current = '' }, [])
  useEffect(() => {
    if (!activeJourney || notified.current === activeJourney.id) return
    if (preferences.notifications.bridgeCompleted) sendLocalNotification('Bridge completed', `${activeJourney.receivedAmount ?? activeJourney.amount} USDC reached your Arc Mainnet wallet.`)
    notified.current = activeJourney.id
  }, [activeJourney, preferences.notifications.bridgeCompleted])

  async function requestEstimate() {
    const key = quoteKey
    setEstimating(true); setQuoteError(null)
    try {
      const value = await circleBridge.estimate(BridgeChain.Solana, amount)
      if (currentQuoteKey.current === key) setQuote({ key, value })
    } catch (error) {
      if (currentQuoteKey.current === key) { setQuote(null); setQuoteError(bridgeErrorMessage(error)) }
    } finally { if (currentQuoteKey.current === key) setEstimating(false) }
  }

  return (
    <div className={dashboardStyles.content}>
      <div className={styles.page}>
        <div className={dashboardStyles.pageHeader}>
        <p className={dashboardStyles.eyebrow}>SOLANA → ARC</p>
        <h1>Bridge USDC from Solana to Arc</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[#6B7280]">
          Move supported SPL USDC from Solana to your connected wallet on Arc Mainnet through Circle&apos;s official bridge route.
        </p>
      </div>

      <div className={styles.summaryGrid}>
        <section className={dashboardStyles.card}>
          <DashboardCardHeader title="Solana Wallet" subtitle="Source wallet for the Solana → Arc transfer." icon="solana" tone="purple" />
          <p className={styles.label}>Connection status</p>
          <div className={styles.walletValue}>{solanaConnected && connectedAddress ? shortAddress(connectedAddress) : 'No wallet selected'}</div>
          <p className={styles.copy}>{solanaConnected && connectedAddress ? 'Connected as the source wallet for this Solana-to-Arc transfer.' : 'Select a supported Solana wallet to bridge supported SPL USDC to Arc.'}</p>
          <button onClick={() => solanaConnected ? void solanaDisconnect() : setSolanaModalVisible(true)} className={styles.solanaButton}>
            {solanaConnected && connectedAddress ? 'Disconnect wallet' : 'Select Solana wallet'}
          </button>
        </section>

        <section className={dashboardStyles.card}>
          <DashboardCardHeader title="SPL USDC" subtitle="Available balance on Solana." icon="wallet" tone="purple" />
          <p className={styles.label}>Solana USDC balance</p>
          <div className={styles.balanceValue}>{!solanaConnected || !connectedAddress ? '—' : solanaBalance.isLoading ? 'Loading…' : <>{solanaBalance.usdcBalance} <UsdcUnit /></>}</div>
          <p className={styles.copy}>{solanaConnected && connectedAddress ? 'Native USDC available to the official Circle Solana adapter.' : 'Connect a Solana wallet to retrieve its supported SPL USDC balance.'}</p>
          {solanaBalance.error && <p className={styles.error}>RPC error: {solanaBalance.error}</p>}
        </section>
      </div>

      <section className={styles.workspace} aria-labelledby="solana-workspace-title">
        <div className={styles.workspaceHeading}>
          <p className={dashboardStyles.eyebrow}>CIRCLE BRIDGE WORKSPACE</p>
          <h2 id="solana-workspace-title">Solana → Arc</h2>
          <p>Official Circle bridge route into your connected Arc wallet.</p>
        </div>
        <div className={styles.workspaceGrid}>
          <section className={`${dashboardStyles.card} ${styles.workspaceCard} ${styles.formColumn}`}>
            <div className={styles.routeLine}><span><DashboardIcon name="solana" /></span><strong>Solana</strong><span aria-hidden="true">→</span><strong>Arc Mainnet</strong></div>
            <p className={styles.copy}>{route ? route.useForwarder ? 'Circle forwarding is available for this route.' : 'Circle requires an Arc wallet signature for the destination mint.' : circleBridge.catalog ? 'Circle does not currently report a supported Solana Mainnet route to Arc.' : 'Checking Circle Solana-to-Arc route support…'}</p>

            <label className={styles.fieldLabel} htmlFor="solana-bridge-amount">Amount</label>
            <BridgeAmountControl id="solana-bridge-amount" value={amount} onChange={setAmount} onMax={() => setAmount(solanaBalance.usdcBalance)} unit={<UsdcUnit />} disabled={journey.working || circleBridge.isLoading} maxDisabled={available === null || available === BigInt(0) || journey.working} invalid={!!issue} />
            <p className={styles.copy}>Available: {available === null ? 'Unavailable' : `${solanaBalance.usdcBalance} USDC`}</p>
            {issue && <p role="alert" className={styles.error}>{issue}</p>}

            <label className={styles.fieldLabel}>Destination</label>
            <div className={bridgeStyles.destination}><span className={styles.arcMark}>A</span><div><strong>Arc Mainnet</strong><small>Connected EVM wallet</small></div><code title={address}>{address ? shortEvmAddress(address) : 'Connect EVM wallet'}</code></div>
            <p className={styles.copy}>The recipient is fixed to your connected EVM wallet. USDC stays in that Arc wallet after the bridge.</p>

            {estimateDetails && <div className={bridgeStyles.estimateStrip}>
              {estimateDetails.providerFee && <div><span>CCTP/provider fee</span><strong>{estimateDetails.providerFee}</strong></div>}
              {estimateDetails.forwardingFee && <div><span>Forwarding fee</span><strong>{estimateDetails.forwardingFee}</strong></div>}
              {estimateDetails.approvalGasReserve && <div><span>Approval gas reserve</span><strong>{estimateDetails.approvalGasReserve}</strong></div>}
              {estimateDetails.burnGasReserve && <div><span>Burn gas reserve</span><strong>{estimateDetails.burnGasReserve}</strong></div>}
            </div>}
            <button type="button" className={bridgeStyles.textButton} disabled={!canBridge || estimating} onClick={() => void requestEstimate()}>{estimating ? 'Getting Circle estimate…' : 'Get Circle estimate ↻'}</button>
            {quoteError && <p role="alert" className={styles.error}>{quoteError}</p>}
            <p className={styles.copy}>Fees are shown only when the installed Circle SDK reports them. Estimates do not sign or submit a transaction.</p>

            <button type="button" className={bridgeStyles.primary} disabled={!canBridge} onClick={() => {
              if (window.confirm(`Bridge ${amount} USDC from Solana to your Arc Mainnet wallet ${address}? Circle fees apply. This moves real USDC.`)) void journey.start(BridgeChain.Solana, amount)
            }}>{journey.bridging || circleBridge.isLoading ? circleBridge.stepLabel : 'Bridge to Arc'}</button>
          </section>

          <section className={`${dashboardStyles.card} ${styles.workspaceCard} ${styles.progressColumn}`}>
            <div className={styles.progressHeading}><h2>Solana → Arc progress</h2><span className={result?.state === 'success' ? bridgeStyles.valid : result?.state === 'error' ? bridgeStyles.error : bridgeStyles.badge}>{result?.state === 'success' ? 'Success' : result?.state ?? 'Ready'}</span></div>
            <ol className={bridgeStyles.stages}>{STAGES.map((label,index) => <li key={label} className={bridgeStyles[stages[index]]} aria-current={stages[index] === 'current' ? 'step' : undefined}><span>{stages[index] === 'completed' ? '✓' : index+1}</span><strong>{label}</strong><small>{stages[index]}</small></li>)}</ol>
            <div role="status" className={bridgeStyles.status}><strong>{result?.state === 'success' ? 'Received on Arc' : circleBridge.stepLabel}</strong><p>{result?.state === 'success' ? activeJourney?.receivedAmount ? `${sixDecimals(activeJourney.receivedAmount)} USDC` : 'USDC is confirmed in your Arc wallet.' : 'Circle Bridge Kit controls approval, burn, attestation, forwarding, and mint recovery.'}</p></div>
            {circleBridge.error && <p role="alert" className={styles.error}>{circleBridge.error}</p>}
            {circleBridge.recoveryNotice && <p role="status" className={bridgeStyles.warning}>{circleBridge.recoveryNotice}</p>}
            <div className={bridgeStyles.actions}>{links.map(link => <a key={link.step+link.hash} href={link.href} target="_blank" rel="noopener noreferrer">{link.label} · {link.step} ↗</a>)}
              {result && circleBridge.resumable && <button type="button" className={bridgeStyles.secondary} disabled={circleBridge.isLoading} onClick={() => { if (window.confirm(`Resume the existing ${result.amount} USDC Solana-to-Arc transfer with Circle?`)) void circleBridge.retry().then(retried => { if (retried?.state === 'success') scheduleWalletRefresh({ kind: 'bridge', source: 'solana' }) }) }}>Resume with Circle</button>}
              {result?.state === 'error' && !circleBridge.resumable && <button type="button" className={bridgeStyles.textButton} onClick={circleBridge.reset}>New transfer</button>}
            </div>
            {circleBridge.pending && !result && <p className={bridgeStyles.warning}>A saved transfer from another source needs review before a new Solana-to-Arc transfer can begin.</p>}
            {circleBridge.technicalError && circleBridge.technicalError !== circleBridge.error && <details><summary>Technical details</summary><pre className={bridgeStyles.recorded}>{circleBridge.technicalError}</pre></details>}

            {result?.state === 'success' && <div className={bridgeStyles.depositPanel} aria-label="Optional Mahshar deposit">
              <div><h3>Mahshar Deposit <span>Optional</span></h3><p>The Solana-to-Arc bridge is complete. Deposit the measured Arc receipt only if you choose.</p></div>
              {activeJourney?.deposit === 'available' && activeJourney.receivedAmount ? <button type="button" className={bridgeStyles.secondary} disabled={journey.depositing} onClick={() => {
                if (window.confirm(`Deposit ${sixDecimals(activeJourney.receivedAmount!)} USDC from your Arc wallet to Mahshar Balance? This is a separate transaction.`)) void journey.deposit()
              }}>Deposit to Mahshar Balance</button> : activeJourney?.deposit === 'current' ? <strong>Confirming Gateway deposit…</strong> : activeJourney?.deposit === 'completed' ? <strong className={bridgeStyles.valid}>{sixDecimals(activeJourney.depositedAmount ?? activeJourney.receivedAmount ?? result.amount)} USDC deposited</strong> : <Link className={bridgeStyles.secondary} href="/dashboard/wallet#deposit">Review deposit in Wallet →</Link>}
              {activeJourney?.depositHash && <a href={Arc.explorerUrl.replace('{hash}',encodeURIComponent(activeJourney.depositHash))} target="_blank" rel="noopener noreferrer">Arc · Gateway deposit ↗</a>}
              {(activeJourney?.deposit === 'failed' || activeJourney?.deposit === 'unavailable') && <p role="status" className={styles.error}>{activeJourney.error ?? 'The optional deposit needs review. The bridge remains successful.'}</p>}
            </div>}
          </section>
        </div>
        </section>
      </div>
    </div>
  )
}
