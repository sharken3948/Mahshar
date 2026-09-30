'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAdminRequest } from '@/components/AdminAccess'
import type { OperationsListingsDto } from '@/lib/admin/operations-types'
import { StatusBadge } from '../operations-ui'
import styles from '../operations.module.css'

type ServerFilters = { status: string; verification: string; source: string; pageSize: number }

function detail(status: { reason: string | null }) { return status.reason ?? 'No exclusion reason.' }

export function ListingsClient() {
  const request = useAdminRequest()
  const [data, setData] = useState<OperationsListingsDto | null>(null)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'empty' | 'degraded' | 'unavailable'>('loading')
  const [page, setPage] = useState(1)
  const [serverFilters, setServerFilters] = useState<ServerFilters>({ status: 'all', verification: 'all', source: 'all', pageSize: 25 })
  const [nameQuery, setNameQuery] = useState('')
  const [contractFilter, setContractFilter] = useState('all')
  const [discoveryFilter, setDiscoveryFilter] = useState('all')
  const requestSequence = useRef(0)

  const load = useCallback(async () => {
    const sequence = ++requestSequence.current
    setPhase(current => data && current !== 'unavailable' ? 'degraded' : 'loading')
    const params = new URLSearchParams({ page: String(page), page_size: String(serverFilters.pageSize), status: serverFilters.status, verification: serverFilters.verification })
    if (serverFilters.source !== 'all') params.set('source', serverFilters.source)
    try {
      const response = await request(`/api/admin/operations/listings?${params}`, { cache: 'no-store' })
      if (!response.ok) throw new Error('listings unavailable')
      const value = await response.json() as OperationsListingsDto
      if (sequence !== requestSequence.current) return
      setData(value); setPhase(value.listings.length ? 'ready' : 'empty')
    } catch {
      if (sequence !== requestSequence.current) return
      setPhase(data ? 'degraded' : 'unavailable')
    }
  }, [data, page, request, serverFilters])

  const loadRef = useRef(load)
  loadRef.current = load
  useEffect(() => { void loadRef.current() }, [page, serverFilters])

  const rows = useMemo(() => {
    const needle = nameQuery.trim().toLowerCase()
    return (data?.listings ?? []).filter(row => {
      if (needle && !row.name.toLowerCase().includes(needle)) return false
      if (contractFilter !== 'all' && row.contract.status.toLowerCase() !== contractFilter) return false
      if (discoveryFilter !== 'all' && row.discovery.status.toLowerCase() !== discoveryFilter) return false
      return true
    })
  }, [contractFilter, data, discoveryFilter, nameQuery])

  const changeFilter = (key: keyof ServerFilters, value: string | number) => {
    setData(null); setPage(1); setServerFilters(current => ({ ...current, [key]: value }))
  }

  const changePage = (nextPage: number) => { setData(null); setPage(nextPage) }

  return <div className={styles.page}>
    <section className={styles.pageHeading}>
      <div><span className={styles.eyebrow}>Read-only inventory</span><h1>APIs &amp; Listings</h1><p>Contract, discovery, and execution eligibility remain separate operational signals.</p></div>
      <button className={styles.primaryButton} type="button" onClick={load} disabled={phase === 'loading'}><span aria-hidden="true">↻</span>Manual refresh</button>
    </section>

    <section className={styles.filterPanel} aria-label="Listing filters">
      <label className={styles.searchField}><span>Search this page</span><input value={nameQuery} onChange={event => setNameQuery(event.target.value)} placeholder="Listing name"/><small>Current {data?.pagination.page_size ?? 25}-row page only</small></label>
      <Filter label="Activity" value={serverFilters.status} onChange={value => changeFilter('status', value)} options={[['all','All'],['active','Active'],['inactive','Inactive']]}/>
      <Filter label="Verification" value={serverFilters.verification} onChange={value => changeFilter('verification', value)} options={[['all','All'],['verified','Verified'],['unverified','Unverified']]}/>
      <Filter label="Source" value={serverFilters.source} onChange={value => changeFilter('source', value)} options={[['all','All'],['seller','Seller'],['discovery','Discovery'],['manual','Manual']]}/>
      <Filter label="Contract · this page" value={contractFilter} onChange={setContractFilter} options={[['all','All'],['valid','Valid'],['invalid','Invalid']]}/>
      <Filter label="Discovery · this page" value={discoveryFilter} onChange={setDiscoveryFilter} options={[['all','All'],['visible','Visible'],['excluded','Excluded']]}/>
    </section>

    <section className={`${styles.panel} ${styles.listingsPanel}`}>
      <header className={styles.panelHeader}>
        <div><span>Bounded production read</span><h2>Listing inventory</h2></div>
        <div className={styles.resultSummary}>{phase === 'degraded' && <em>Refresh failed · showing prior result</em>}<strong>{data ? `${data.pagination.total.toLocaleString()} total` : '—'}</strong></div>
      </header>
      {phase === 'loading' && <div className={styles.sectionLoading}><span/><span/><span/></div>}
      {phase === 'unavailable' && <div className={styles.sectionMessage}><strong>Listings unavailable</strong><span>The Admin read failed. Marketplace and execution remain unaffected.</span><button type="button" onClick={load}>Try again</button></div>}
      {phase === 'empty' && <div className={styles.sectionMessage}><strong>No listings found</strong><span>There are no rows for the selected server filters.</span></div>}
      {data && rows.length === 0 && phase !== 'empty' && <div className={styles.sectionMessage}><strong>No matches on this page</strong><span>Clear the page-only name, contract, or discovery filter.</span></div>}
      {rows.length > 0 && <div className={styles.tableViewport}>
        <table className={`${styles.table} ${styles.listingsTable}`}>
          <thead><tr><th>Listing</th><th>Seller / price</th><th>Inventory</th><th>Contract</th><th>Discovery</th><th>Execution</th><th>Source / score</th></tr></thead>
          <tbody>{rows.map(row => <tr key={row.id}>
            <td data-label="Listing"><strong>{row.name}</strong><small>{row.category}</small><code>{row.id}</code></td>
            <td data-label="Seller / price"><code>{row.seller_wallet}</code><small>{row.price_per_call ? `${row.price_per_call} USDC / call` : 'Price unavailable'}</small></td>
            <td data-label="Inventory"><StatusBadge value={row.active ? 'ACTIVE' : 'INACTIVE'}/><StatusBadge value={row.verified ? 'VERIFIED' : 'UNVERIFIED'}/></td>
            <td data-label="Contract"><StatusBadge value={row.contract.status}/><small title={detail(row.contract)}>{detail(row.contract)}</small></td>
            <td data-label="Discovery"><StatusBadge value={row.discovery.status}/><small title={detail(row.discovery)}>{detail(row.discovery)}</small></td>
            <td data-label="Execution"><StatusBadge value={row.execution.status}/><small title={detail(row.execution)}>{detail(row.execution)}</small></td>
            <td data-label="Source / score"><span>{row.source}</span><small>{row.score === null ? 'No advisory score' : `Advisory score ${row.score}`}</small></td>
          </tr>)}</tbody>
        </table>
      </div>}
      {data && <footer className={styles.pagination}>
        <div><label>Rows <select value={serverFilters.pageSize} onChange={event => changeFilter('pageSize', Number(event.target.value))}><option value={25}>25</option><option value={50}>50</option></select></label><span>Page {data.pagination.page} of {Math.max(1, data.pagination.total_pages)}</span></div>
        <div><button type="button" onClick={() => changePage(Math.max(1, page - 1))} disabled={page <= 1 || phase === 'loading'}>Previous</button><button type="button" onClick={() => changePage(page + 1)} disabled={page >= data.pagination.total_pages || phase === 'loading'}>Next</button></div>
      </footer>}
    </section>
  </div>
}

function Filter({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: string[][] }) {
  return <label className={styles.filterField}><span>{label}</span><select value={value} onChange={event => onChange(event.target.value)}>{options.map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>
}
