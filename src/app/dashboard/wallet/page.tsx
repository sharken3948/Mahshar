'use client'

import { ConnectButton } from '@rainbow-me/rainbowkit'
import { useState } from 'react'
import { IS_ARC_MAINNET, useDashboardWorkspace } from '../dashboard-workspace'
import { DashboardCardHeader, DashboardIcon, UsdcUnit } from '../dashboard-visuals'
import { useProductPreferences } from '@/components/ProductPreferencesProvider'
import styles from '../dashboard.module.css'

export default function WalletDashboardPage() {
  const { formatUsdc } = useProductPreferences()
  const {
    address, isConnected, connector, publicClient, gatewayStats, walletUsdcRaw, walletUsdcStatus, walletUsdcLoading,
    depositAmount, setDepositAmount, depositStep, depositError, setDepositError,
    withdrawAmount, setWithdrawAmount, withdrawStep, withdrawError, withdrawFlatFee,
    initiateStep, initiateError, releaseStep, releaseError,
    withdrawingRaw, withdrawalBlockRaw, currentBlock,
    handleDeposit, handleWithdraw, handleInitiateWithdraw, handleReleasePending,
  } = useDashboardWorkspace()
  const [copyFeedback, setCopyFeedback] = useState<{ address: string; message: string } | null>(null)
  const depositing = depositStep !== 'idle'

  return (
    <div className={styles.content}>
      <div className={styles.pageHeader}>
        <p className={styles.eyebrow}>YOUR FUNDS, CONNECTED</p>
        <h1>Wallet</h1>
        <p className="mt-2 text-sm text-slate-500">Manage your wallet USDC, Mahshar balance, and pending withdrawals.</p>
      </div>

      {!isConnected ? (
        <div className="flex min-h-[50vh] flex-col items-center justify-center gap-6">
          <div className="rounded-2xl bg-blue-50 p-5 text-[#2775CA]"><DashboardIcon name="wallet" /></div>
          <h2 className="text-2xl font-bold">Connect Your Wallet</h2>
          <p className="text-center text-sm text-slate-500">Connect to view your balances and manage your USDC.</p>
          <ConnectButton />
        </div>
      ) : (
        <>
          <div className={`${styles.walletSummary} mb-8 grid min-w-0 gap-5 lg:grid-cols-3`}>
            <section className={`${styles.card} ${styles.walletSummaryCard}`}>
              <p className="text-sm font-semibold text-[#2775CA]">Wallet USDC</p>
              <div className={styles.balanceValue}>{walletUsdcRaw != null ? formatUsdc(walletUsdcRaw, true) : '—'} <UsdcUnit /></div>
              <p className="text-xs text-slate-500">{walletUsdcStatus === 'stale' ? 'Last known balance · refreshing in the background.' : walletUsdcStatus === 'unknown' ? walletUsdcLoading ? 'Checking balance…' : 'Balance temporarily unavailable.' : 'Held in your own wallet on Arc.'}</p>
            </section>
            <section className={`${styles.card} ${styles.walletSummaryCard}`}>
              <p className="text-sm font-semibold text-[#B6536C]">Mahshar Balance</p>
              <div className={styles.balanceValue}>{gatewayStats ? formatUsdc(gatewayStats.gatewayAvailable) : '—'} <UsdcUnit /></div>
              <p className="text-xs text-slate-500">Your available Gateway balance for paid APIs.</p>
            </section>
            <section className={`${styles.card} ${styles.walletSummaryCard}`}>
              <p className="text-sm font-semibold text-slate-600">Pending withdrawal</p>
              <div className={styles.balanceValue}>{withdrawingRaw != null ? formatUsdc(withdrawingRaw, true) : '—'} <UsdcUnit /></div>
              <p className="text-xs text-slate-500">USDC in the trustless withdrawal path.</p>
            </section>
          </div>

          <div className={`${styles.cards} ${styles.walletActions}`}>
            <section id="deposit" className={styles.card}>
              <DashboardCardHeader title="Deposit" subtitle="From your wallet to your Mahshar balance." icon="wallet" tone="blue" />
            <h2 className="text-sm font-bold text-[#0D0D0D] mb-3">Add to Mahshar Balance</h2>
              <>
                <div className={styles.directDepositRoute} aria-label="Direct Arc deposit route"><span>Arc Mainnet Wallet</span><i aria-hidden="true">→</i><span>Mahshar Balance</span></div>
                <p className={styles.directDepositCopy}>Deposit USDC already held in your Arc wallet into your Mahshar Balance.</p>
                <div className={styles.availableArcBalance}><span>{walletUsdcStatus === 'stale' ? 'Last known Arc balance' : 'Available in Arc wallet'}</span><strong>{walletUsdcRaw != null ? formatUsdc(walletUsdcRaw, true) : '—'} <UsdcUnit /></strong></div>
                {walletUsdcStatus === 'unknown' && <p className="text-xs text-slate-500 mb-2">{walletUsdcLoading ? 'Checking Arc wallet balance…' : 'Balance temporarily unavailable. Mahshar is retrying automatically.'}</p>}
                {walletUsdcStatus === 'stale' && <p className="text-xs text-slate-500 mb-2">Refreshing before deposits are enabled.</p>}
                <div className="flex gap-2 items-center">
                  <input
                    type="number"
                    value={depositAmount}
                    onChange={e => setDepositAmount(e.target.value)}
                    placeholder="0.00"
                    min="0"
                    step="0.01"
                    className="w-full flex-1 bg-[#FAFAF8] border border-[#2775CA] rounded-lg px-3 py-2 text-sm text-[#0D0D0D] placeholder-[#6B7280] focus:outline-none focus:border-[#2775CA]"
                  />
                  <UsdcUnit />
                  <button
                    onClick={handleDeposit}
                    disabled={depositing || !depositAmount || !publicClient || walletUsdcStatus !== 'fresh' || walletUsdcLoading}
                    className="bg-[#2775CA] hover:bg-[#1E63B5] text-white px-3 py-2 rounded-lg text-sm font-medium disabled:opacity-50 transition-colors"
                  >
                    {depositStep === 'approving' ? 'Approving...' : depositStep === 'depositing' ? 'Depositing...' : 'Deposit'}
                  </button>
                </div>
                {depositError && <p className="text-xs text-[#DC2626] mt-2">{depositError}</p>}
              </>
            </section>
            <section className={styles.card}>
              <DashboardCardHeader title="Withdraw" subtitle="Return your Mahshar balance to your wallet." icon="balance" tone="pink" />
              <h2 className="text-sm font-bold text-[#0D0D0D] mb-3">Withdraw from Mahshar Balance</h2>
              <p className="text-xs text-[#6B7280] mb-3">Move USDC from your Mahshar balance back to your wallet.</p>
              <div className="flex gap-2 items-center">
                <input
                  type="number"
                  value={withdrawAmount}
                  aria-label="Mahshar balance withdrawal amount in USDC"
                  onChange={e => setWithdrawAmount(e.target.value)}
                  placeholder="0.00"
                  min="0"
                  step="0.01"
                  className="w-full flex-1 bg-[#FAFAF8] border border-[#2775CA] rounded-lg px-3 py-2 text-sm text-[#0D0D0D] placeholder-[#6B7280] focus:outline-none focus:border-[#2775CA]"
                />
                <UsdcUnit />
                <button
                    onClick={handleWithdraw}
                    disabled={withdrawStep !== 'idle' || !withdrawAmount || !connector}
                    className="bg-[#00B050] hover:bg-[#008F42] text-white px-3 py-2 rounded-lg text-sm font-medium disabled:opacity-50 transition-colors"
                  >
                    {withdrawStep === 'withdrawing' ? 'Withdrawing...' : 'Withdraw'}
                  </button>
              </div>
              {withdrawFlatFee !== null && withdrawAmount && parseFloat(withdrawAmount) > 0 && (
                <p className="text-xs text-[#6B7280] mt-2">
                  Estimated fee: ~{formatUsdc(withdrawFlatFee)} USDC (gas + forwarder). You receive{' '}
                  <span className="font-medium">{formatUsdc(parseFloat(withdrawAmount))} USDC</span>; total deducted from your balance:{' '}
                  ~{formatUsdc(parseFloat(withdrawAmount) + withdrawFlatFee)} USDC.
                </p>
              )}
              {withdrawError && <p className="text-xs text-[#DC2626] mt-2">{withdrawError}</p>}
              {IS_ARC_MAINNET && (
                <p className="text-xs text-[#6B7280] mt-2">
                  <button
                    onClick={handleInitiateWithdraw}
                    disabled={initiateStep !== 'idle' || !withdrawAmount || !publicClient}
                    className="underline hover:text-[#0D0D0D] disabled:opacity-50 transition-colors"
                  >
                    {initiateStep === 'initiating' ? 'Initiating...' : 'Trustless withdrawal (7 days)'}
                  </button>
                  {initiateError && <span className="text-[#DC2626] ml-1">{initiateError}</span>}
                </p>
              )}


            </section>
          </div>

          <div className={`${styles.cards} ${styles.walletDetails}`}>
            <section className={styles.card}>
              <h2 className="text-lg font-bold">Pending withdrawal / Release</h2>
              {withdrawingRaw != null && withdrawingRaw > BigInt(0) && (
                <div className="mt-4 pt-3 border-t border-[#E5E7EB]">
                  <div className="text-xs text-[#6B7280] mb-2">Pending withdrawal (initiated via 7-day trustless path)</div>
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <div className={styles.pendingValue}>{formatUsdc(withdrawingRaw, true)} <UsdcUnit /></div>
                      {(() => {
                        if (withdrawalBlockRaw == null || currentBlock == null) {
                          return <div className="text-xs text-[#6B7280]">Checking readiness...</div>
                        }
                        if (currentBlock >= withdrawalBlockRaw) {
                          return <div className="text-xs text-[#16A34A]">Ready to release</div>
                        }
                        const remaining = withdrawalBlockRaw - currentBlock
                        return <div className="text-xs text-[#6B7280]">Available in {remaining.toString()} blocks</div>
                      })()}
                    </div>
                    <button
                      onClick={handleReleasePending}
                      disabled={
                        releaseStep !== 'idle' ||
                        !publicClient ||
                        withdrawalBlockRaw == null ||
                        currentBlock == null ||
                        currentBlock < withdrawalBlockRaw
                      }
                      className="bg-[#2775CA] hover:bg-[#1E63B5] text-white px-3 py-2 rounded-lg text-sm font-medium disabled:opacity-50 transition-colors"
                    >
                      {releaseStep === 'releasing' ? 'Releasing...' : 'Release'}
                    </button>
                  </div>
                  {releaseError && <p className="text-xs text-[#DC2626] mt-2">{releaseError}</p>}
                </div>
              )}
              {withdrawingRaw == null && <p className="text-sm text-slate-500">Pending withdrawal balance is not available yet.</p>}
              {withdrawingRaw === BigInt(0) && <p className="text-sm text-slate-500">No pending trustless withdrawal.</p>}
            </section>
            <section className={styles.card}>
              <h2 className="text-lg font-bold">Connected wallet</h2>
              <p className="text-sm text-slate-500">Arc Mainnet · Balance network</p>
              <code className="mt-4 block break-all text-sm text-slate-700">{address}</code>
              <button
                type="button"
                onClick={async () => {
                  if (!address) return
                  try {
                    await navigator.clipboard.writeText(address)
                    setCopyFeedback({ address, message: 'Address copied.' })
                  } catch {
                    setCopyFeedback({ address, message: 'Could not copy. Select the address to copy it manually.' })
                  }
                }}
                className="mt-4 bg-blue-50 px-4 py-2 text-sm font-medium text-[#2775CA] hover:bg-blue-100"
              >Copy address</button>
              <p role="status" className="text-xs text-slate-500">{copyFeedback?.address === address ? copyFeedback?.message : ''}</p>
            </section>
          </div>
        </>
      )}
    </div>
  )
}
