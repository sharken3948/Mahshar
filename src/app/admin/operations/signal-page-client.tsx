'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAdminRequest } from '@/components/AdminAccess'
import type { InfrastructureDto, SystemHealthDto } from '@/lib/admin/operations-types'
import { SectionState, SignalGrid, type OperationsPhase } from './operations-ui'
import styles from './operations.module.css'

type SignalData = InfrastructureDto | SystemHealthDto

export function SignalPageClient({ endpoint, eyebrow, title, description }: { endpoint: string; eyebrow: string; title: string; description: string }) {
  const request = useAdminRequest()
  const [data, setData] = useState<SignalData | null>(null)
  const [phase, setPhase] = useState<OperationsPhase>('loading')
  const sequence = useRef(0)
  const load = useCallback(async () => {
    const current = ++sequence.current
    setPhase(previous => data && previous !== 'unavailable' ? 'degraded' : 'loading')
    try {
      const response = await request(endpoint, { cache: 'no-store' })
      if (!response.ok) throw new Error('signals unavailable')
      const value = await response.json() as SignalData
      if (current !== sequence.current) return
      setData(value); setPhase('ready')
    } catch { if (current === sequence.current) setPhase(data ? 'degraded' : 'unavailable') }
  }, [data, endpoint, request])
  const loadRef = useRef(load)
  loadRef.current = load
  useEffect(() => { void loadRef.current() }, [endpoint])

  return <div className={styles.page}>
    <section className={styles.pageHeading}>
      <div><span className={styles.eyebrow}>{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>
      <button className={styles.primaryButton} type="button" onClick={load} disabled={phase === 'loading'}><span aria-hidden="true">↻</span>Manual refresh</button>
    </section>
    {phase === 'degraded' && <div className={styles.degradedBanner}>Refresh failed · showing the previous isolated Admin result.</div>}
    {!data && <section className={styles.panel}><SectionState phase={phase} empty="No signals are available." onRetry={load}/></section>}
    {data && <SignalGrid signals={data.signals}/>}
    <p className={styles.probeNote}>Read-only evidence only · fixed destinations · no payments, signatures, inference, rate-limit writes, or seller probes.</p>
  </div>
}
