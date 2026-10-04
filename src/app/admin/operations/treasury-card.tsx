import type { TreasuryBalanceDto } from '@/lib/admin/operations-types'
import { timeLabel, type OperationsPhase } from './operations-ui'
import styles from './operations.module.css'

export type TreasuryCardResource = { phase: OperationsPhase; data: TreasuryBalanceDto | null }

function displayUsdc(value: string) {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value)
  if (!match) return 'Unavailable'
  const whole = BigInt(match[1]).toLocaleString()
  let fraction = (match[2] ?? '').padEnd(2, '0')
  while (fraction.length > 2 && fraction.endsWith('0')) fraction = fraction.slice(0, -1)
  return `${whole}.${fraction}`
}

function shortWallet(wallet: string) {
  return wallet.length > 14 ? `${wallet.slice(0, 8)}…${wallet.slice(-6)}` : wallet
}

export function TreasuryCard({ resource, onRetry }: { resource: TreasuryCardResource; onRetry: () => Promise<void> }) {
  const data = resource.data
  return <section className={styles.treasuryCard} aria-label="Arc Mainnet wallet USDC balance">
    <div className={styles.treasuryIntro}>
      <span>Arc Mainnet · read only</span>
      <h2>Arc Mainnet wallet USDC balance</h2>
      <p>Direct wallet balance only. It excludes the separate Circle Gateway balance, is not an exact accumulated platform-fee total, and may include manual or unrelated USDC.</p>
    </div>
    <div className={styles.treasuryValue}>
      {resource.phase === 'loading' && !data
        ? <span className={styles.treasurySkeleton}/>
        : data
          ? <><strong>{displayUsdc(data.balance_usdc)} <small>USDC</small></strong>
            <div><a href={data.explorer_url} target="_blank" rel="noreferrer" title={data.wallet}>{shortWallet(data.wallet)} ↗</a>
              <span>{resource.phase === 'degraded' || data.status === 'stale' ? 'Last known' : 'Updated'} {timeLabel(data.as_of)}</span></div></>
          : <><strong className={styles.treasuryUnavailable}>Unavailable</strong><button type="button" onClick={onRetry}>Retry</button></>}
    </div>
  </section>
}
