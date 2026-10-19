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

export function GatewayTreasuryCard({ resource, onRetry }: {
  resource: { phase: OperationsPhase; data: GatewayTreasuryDto | null }
  onRetry: () => Promise<void>
}) {
  const data = resource.data
  const stale = resource.phase === 'degraded'
  return <section className={styles.gatewayTreasuryCard} aria-label="Circle Gateway treasury balance">
    <div className={styles.treasuryIntro}>
      <span>Circle Gateway · read only</span>
      <h2>Gateway treasury</h2>
      <p>Circle-reported USDC for the verified Arc platform depositor. Separate from the direct Arc wallet.</p>
    </div>
    {resource.phase === 'loading' && !data ? <span className={styles.treasurySkeleton}/> : data ? <>
      <dl className={styles.gatewayTreasuryRows}>
        <div><dt>Total Gateway funds</dt><dd>{displayUsdc(data.total_balance_usdc)} USDC</dd></div>
        <div><dt>Available Gateway funds</dt><dd>{displayUsdc(data.available_balance_usdc)} USDC</dd></div>
        <div><dt>Known outstanding seller liabilities</dt><dd>{displayUsdc(data.known_seller_liabilities_usdc)} USDC</dd></div>
        <div><dt>Mahshar-owned commission</dt><dd>Verification pending</dd></div>
        <div><dt>Safely withdrawable commission</dt><dd>Verification pending</dd></div>
      </dl>
      <p className={styles.gatewayTreasuryStatus}>
        {stale ? 'Stale result · ' : ''}
        {data.coverage === 'known_shortfall' ? 'Known seller liabilities exceed available Gateway funds.' : 'Available funds cover known recorded seller liabilities.'}
        {' '}Full ownership reconciliation remains pending.
        {data.historical_unallocated_purchases > 0 && ` ${data.historical_unallocated_purchases} historical purchases lack recorded seller shares.`}
        {data.unresolved_withdrawals > 0 && ` ${data.unresolved_withdrawals} seller withdrawals need reconciliation.`}
        {data.withdrawing_usdc !== '0.000000' && ` ${displayUsdc(data.withdrawing_usdc)} USDC is withdrawing.`}
        {data.pending_batch_usdc && data.pending_batch_usdc !== '0.000000' && ` ${displayUsdc(data.pending_batch_usdc)} USDC is pending batch confirmation.`}
      </p>
      <small className={styles.gatewayTreasuryTime}>{stale ? 'Last successful refresh' : 'Updated'} {timeLabel(data.as_of)}</small>
      {stale && <button type="button" onClick={onRetry}>Retry</button>}
    </> : <div className={styles.gatewayTreasuryUnavailable}><strong>Unavailable</strong><p>Gateway balance or seller ledger could not be verified.</p><button type="button" onClick={onRetry}>Retry</button></div>}
  </section>
}
