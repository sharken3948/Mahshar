"use client"

import { useRef, useState } from 'react'
import type { GatewayTreasuryDto } from '@/lib/admin/operations-types'
import { timeLabel, type OperationsPhase } from './operations-ui'
import styles from './operations.module.css'

function displayUsdc(value: string) {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value)
  if (!match) return 'Unavailable'
  const whole = BigInt(match[1]).toLocaleString()
  const fraction = (match[2] ?? '').padEnd(2, '0').replace(/0+$/, '')
  return `${whole}.${fraction || '00'}`
}

export function GatewayTreasuryCard({ resource, onRetry, request }: {
  resource: { phase: OperationsPhase; data: GatewayTreasuryDto | null }
  onRetry: () => Promise<void>
  request: (url: string, init?: RequestInit) => Promise<Response>
}) {
  const data = resource.data
  const stale = resource.phase === 'degraded'
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const pendingRequest = useRef<{ amount: string; key: string; sourceFeeCap: string; destinationGas: string } | null>(null)
  const toMicros = (value: string) => /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value)
    ? BigInt(value.split('.')[0]) * BigInt(1_000_000) + BigInt((value.split('.')[1] ?? '').padEnd(6, '0')) : null
  const safe = data?.safely_withdrawable_usdc ? toMicros(data.safely_withdrawable_usdc) : null
  const requested = toMicros(amount)
  const feeCap = data?.withdrawal_fee_quote ? toMicros(data.withdrawal_fee_quote.source_fee_cap_usdc) : null
  const enabled = resource.phase === 'ready' && data?.withdrawal_ready === true && data.withdrawal_fee_quote !== null &&
    safe !== null && safe >= BigInt(50_000)
  const validAmount = enabled && requested !== null && requested >= BigInt(50_000) &&
    requested <= BigInt(10_000_000_000) && safe !== null && requested <= safe && feeCap !== null && requested > feeCap

  async function withdraw() {
    if (!validAmount || busy || !data) return
    setBusy(true)
    setMessage(null)
    try {
      if (!pendingRequest.current || pendingRequest.current.amount !== amount) {
        const quoteResponse = await request('/api/admin/operations/gateway-treasury/withdraw/quote', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount_usdc: amount }),
        })
        const quote = await quoteResponse.json()
        if (!quoteResponse.ok) throw new Error(quote.error ?? 'Fee quote unavailable')
        const confirmed = window.confirm(`Withdraw ${amount} USDC to ${data.depositor}?\n` +
          `Circle source fee cap: ${quote.source_fee_cap_usdc} USDC from Gateway.\n` +
          `Estimated Arc mint gas: ${quote.destination_gas_estimate_usdc} USDC from the platform wallet.\n` +
          `Expected wallet receipt: ${quote.mint_value_usdc} USDC. This transfer cannot be undone.`)
        if (!confirmed) return
        pendingRequest.current = { amount, key: crypto.randomUUID(),
          sourceFeeCap: quote.source_fee_cap_usdc, destinationGas: quote.destination_gas_estimate_usdc }
      }
      const pending = pendingRequest.current
      const response = await request('/api/admin/operations/gateway-treasury/withdraw', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount_usdc: amount, idempotency_key: pending.key,
          quoted_source_fee_cap_usdc: pending.sourceFeeCap,
          quoted_destination_gas_estimate_usdc: pending.destinationGas,
          confirm: true }),
      })
      const result = await response.json()
      if (['minted', 'expired', 'failed'].includes(result.status)) pendingRequest.current = null
      setMessage(response.ok ? `Withdrawal ${result.status}. Reference: ${result.withdrawal_id}` :
        `${result.error ?? 'Withdrawal outcome unavailable'}${result.withdrawal_id ? ` Reference: ${result.withdrawal_id}` : ''}`)
      await onRetry()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Withdrawal unavailable')
    } finally { setBusy(false) }
  }
  return <section className={styles.gatewayTreasuryCard} aria-label="Circle Gateway treasury balance">
    <div className={styles.treasuryIntro}>
      <span>Circle Gateway · Admin treasury</span>
      <h2>Gateway treasury</h2>
      <p>Circle-reported USDC for the verified Arc platform depositor. Separate from the direct Arc wallet.</p>
    </div>
    {resource.phase === 'loading' && !data ? <span className={styles.treasurySkeleton}/> : data ? <>
      <dl className={styles.gatewayTreasuryRows}>
        <div><dt>Total Gateway funds</dt><dd>{displayUsdc(data.total_balance_usdc)} USDC</dd></div>
        <div><dt>Available Gateway funds</dt><dd>{displayUsdc(data.available_balance_usdc)} USDC</dd></div>
        <div><dt>Known outstanding seller liabilities</dt><dd>{displayUsdc(data.known_seller_liabilities_usdc)} USDC</dd></div>
        <div><dt>Completed Arc x402 commission ({data.completed_arc_purchase_count} {data.completed_arc_purchase_count === 1 ? 'purchase' : 'purchases'})</dt><dd>{displayUsdc(data.completed_arc_commission_usdc)} USDC</dd></div>
        <div><dt>Historical calculated commission, no durable binding ({data.historical_calculated_purchase_count} {data.historical_calculated_purchase_count === 1 ? 'purchase' : 'purchases'})</dt><dd>{displayUsdc(data.historical_calculated_commission_usdc)} USDC</dd></div>
        <div><dt>Total recorded gross commissions</dt><dd>{displayUsdc(data.total_recorded_gross_commission_usdc)} USDC</dd></div>
        <div><dt>Completed platform withdrawals (Gateway debit caps)</dt><dd>{displayUsdc(data.previously_withdrawn_platform_commission_usdc)} USDC</dd></div>
        <div><dt>Reserved platform commissions</dt><dd>{displayUsdc(data.reserved_platform_commission_usdc)} USDC</dd></div>
        <div><dt>Gateway Platform Balance</dt><dd>{displayUsdc(data.gateway_platform_balance_usdc)} USDC</dd></div>
        <div><dt>Withdrawable amount (including Circle fee cap)</dt><dd>{data.safely_withdrawable_usdc === null ? 'Unavailable' : `${displayUsdc(data.safely_withdrawable_usdc)} USDC`}</dd></div>
        {data.withdrawal_fee_quote && <>
          <div><dt>Circle fee cap at withdrawal limit</dt><dd>{displayUsdc(data.withdrawal_fee_quote.source_fee_cap_usdc)} USDC</dd></div>
          <div><dt>Expected wallet receipt at withdrawal limit</dt><dd>{displayUsdc(data.withdrawal_fee_quote.mint_value_usdc)} USDC</dd></div>
        </>}
      </dl>
      <p className={styles.gatewayTreasuryStatus}>
        {stale ? 'Stale result · ' : ''}
        {data.coverage === 'known_shortfall' ? 'Known seller liabilities exceed available Gateway funds.' : 'Available funds cover known recorded seller liabilities.'}
        {' '}Gateway Platform Balance is recorded commission entitlement. Circle reports total Gateway custody and does not separately hold or guarantee this commission.
        {' '}The withdrawal amount includes the Circle fee cap; Arc mint gas is paid from the platform wallet.
        {data.historical_unallocated_purchases > 0 && ` ${data.historical_unallocated_purchases} historical purchases lack recorded seller shares.`}
        {data.unresolved_withdrawals > 0 && ` ${data.unresolved_withdrawals} seller withdrawals need reconciliation.`}
        {data.unresolved_settlement_attempts > 0 && ` ${data.unresolved_settlement_attempts} settlement attempts remain unresolved.`}
        {data.commission_accounting_issues > 0 && ` ${data.commission_accounting_issues} commission accounting records need reconciliation.`}
        {data.unresolved_commission_withdrawals > 0 && ` ${data.unresolved_commission_withdrawals} platform withdrawals need reconciliation.`}
        {data.withdrawing_usdc !== '0.000000' && ` ${displayUsdc(data.withdrawing_usdc)} USDC is withdrawing.`}
        {data.pending_batch_usdc && data.pending_batch_usdc !== '0.000000' && ` ${displayUsdc(data.pending_batch_usdc)} USDC is pending batch confirmation.`}
      </p>
      <div className={styles.gatewayWithdrawControls} aria-label="Commission withdrawal">
        <label htmlFor="gateway-commission-amount">Withdraw to Platform Wallet · amount (USDC)</label>
        <div><input id="gateway-commission-amount" type="text" inputMode="decimal" value={amount}
          onChange={event => setAmount(event.target.value)} disabled={!enabled || busy} aria-describedby="gateway-withdraw-status" />
          <button type="button" disabled={!validAmount || busy} onClick={withdraw}>
            {busy ? 'Processing…' : 'Withdraw to Platform Wallet'}</button></div>
        <small id="gateway-withdraw-status">{message ?? (enabled ? `Fixed destination: ${data.depositor}` :
          `Withdrawal disabled. ${data.withdrawal_block_reason ?? 'Verification pending.'} Minimum when enabled: 0.05 USDC.`)}</small>
      </div>
      <small className={styles.gatewayTreasuryTime}>{stale ? 'Last successful refresh' : 'Updated'} {timeLabel(data.as_of)}</small>
      {stale && <button type="button" onClick={onRetry}>Retry</button>}
    </> : <div className={styles.gatewayTreasuryUnavailable}><strong>Unavailable</strong><p>Gateway balance or seller ledger could not be verified.</p><button type="button" onClick={onRetry}>Retry</button></div>}
  </section>
}
