'use client'

import type { ReactNode } from 'react'
import styles from './bridge.module.css'

interface BridgeAmountControlProps {
  id: string
  value: string
  onChange(value: string): void
  onMax(): void
  unit: ReactNode
  disabled?: boolean
  maxDisabled?: boolean
  invalid?: boolean
  describedBy?: string
}

/** Shared visual amount field for EVM and Solana Circle bridge workspaces. */
export function BridgeAmountControl({
  id,
  value,
  onChange,
  onMax,
  unit,
  disabled = false,
  maxDisabled = false,
  invalid = false,
  describedBy,
}: BridgeAmountControlProps) {
  return (
    <div className={styles.amount}>
      <input
        id={id}
        className={styles.amountInput}
        inputMode="decimal"
        placeholder="0.0000"
        value={value}
        disabled={disabled}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        onChange={event => onChange(event.target.value)}
      />
      {unit}
      <button type="button" className={styles.amountMax} disabled={maxDisabled} onClick={onMax}>MAX</button>
    </div>
  )
}
