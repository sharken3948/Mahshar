'use client'

import { ConnectButton } from '@rainbow-me/rainbowkit'
import { useCallback, useEffect, useState } from 'react'
import { useMarketplaceSession } from '@/components/MarketplaceSessionProvider'
import type { TransactionFilter, TransactionHistory, TransactionRecord } from '@/lib/dashboard-transactions'
import { DashboardIcon } from '../dashboard-visuals'
import { useDashboardWorkspace } from '../dashboard-workspace'
import { TransactionHistoryContent } from './transactions-content'
import styles from './transactions.module.css'

export default function TransactionsPage() {
  const { address, isConnected } = useDashboardWorkspace()
  const session = useMarketplaceSession()
  const [filter, setFilter] = useState<TransactionFilter>('all')
  const [page, setPage] = useState(1)
  const [refreshKey, setRefreshKey] = useState(0)
  const [history, setHistory] = useState<TransactionHistory | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<TransactionRecord | null>(null)
  const [copied, setCopied] = useState(false)
  const authenticated = session.status === 'authenticated'
    && !!address && session.wallet?.toLowerCase() === address.toLowerCase()

  useEffect(() => {
    setHistory(null)
    setSelected(null)
    setPage(1)
  }, [address])

  useEffect(() => {
    if (!authenticated) return
    const controller = new AbortController()
    let current = true
    setLoading(true)
    setError(null)
    session.request(`/api/dashboard/transactions?filter=${filter}&page=${page}&limit=25`, {
      cache: 'no-store',
      signal: controller.signal,
    }).then(async response => {
      const body = await response.json().catch(() => null) as TransactionHistory | { error?: string } | null
      if (!current) return
      if (!response.ok || !body || !('records' in body)) throw new Error(body && 'error' in body ? body.error : 'Transaction history is unavailable.')
      setHistory(body)
    }).catch(fetchError => {
      if (!current || controller.signal.aborted) return
      setError(fetchError instanceof Error ? fetchError.message : 'Transaction history is unavailable.')
    }).finally(() => { if (current) setLoading(false) })
    return () => { current = false; controller.abort() }
  }, [authenticated, filter, page, refreshKey, session.request])

  useEffect(() => {
    if (!selected) return
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setSelected(null) }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [selected])

  const copy = useCallback(async (value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1_500)
    } catch { setCopied(false) }
  }, [])

  if (!isConnected) {
    return <div className={styles.connectState}><span><DashboardIcon name="transactions" /></span><h1>Connect Your Wallet</h1><p>Connect a wallet to view its Mahshar transaction records.</p><ConnectButton /></div>
  }

  if (!authenticated) {
    const busy = session.status === 'checking' || session.status === 'signing'
    return <div className={styles.connectState}><span><DashboardIcon name="transactions" /></span><h1>Transactions</h1><p>Sign in with the connected wallet to view its private purchases, earnings, and withdrawals.</p><button type="button" disabled={busy} onClick={() => { void session.authenticate() }}>{busy ? 'Checking session…' : 'Sign in'}</button>{session.error && <small role="alert">{session.error}</small>}</div>
  }

  return <TransactionHistoryContent
    history={history} loading={loading} error={error} filter={filter} selected={selected} copied={copied}
    onFilter={value => { setFilter(value); setPage(1); setSelected(null) }}
    onRefresh={() => setRefreshKey(key => key + 1)} onRetry={() => setRefreshKey(key => key + 1)}
    onPrevious={() => setPage(value => Math.max(1, value - 1))}
    onNext={() => setPage(value => history ? Math.min(history.maxPage, value + 1) : value)}
    onSelect={record => { setSelected(record); setCopied(false) }} onClose={() => setSelected(null)}
    onCopy={value => { void copy(value) }}
  />
}
