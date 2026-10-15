'use client'

import { useId, useState, type ReactNode } from 'react'
import styles from './worker.module.css'

export function CompactRecords<T>({ records, label, children }: {
  records: T[]; label: string; children: (visible: T[]) => ReactNode
}) {
  const [expanded, setExpanded] = useState(false)
  const id = useId()
  return <>
    <div id={id} className={expanded ? styles.historyViewport : undefined}
      role={expanded ? 'region' : undefined} aria-label={expanded ? label : undefined} tabIndex={expanded ? 0 : undefined}>
      {children(expanded ? records : records.slice(0, 3))}
    </div>
    {records.length > 3 && <div className={styles.pagination}>
      <span>{expanded ? records.length : 3} of {records.length} available records</span>
      <button type="button" className={styles.detailsButton} aria-expanded={expanded} aria-controls={id}
        onClick={() => setExpanded(value => !value)}>{expanded ? 'Show Less' : 'View All'}</button>
    </div>}
  </>
}
