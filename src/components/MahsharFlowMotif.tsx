'use client'

import { useId } from 'react'
import styles from './mahshar-flow.module.css'

type FlowTone = 'blue' | 'green' | 'pink' | 'purple'
type FlowVariant = 'card' | 'background' | 'route'

export function MahsharFlowMotif({ variant, tone, className }: { variant: FlowVariant; tone: FlowTone; className?: string }) {
  const id = useId().replace(/:/g, '')
  const gradientId = `mahshar-flow-${id}`
  const classes = [styles.flowMotif, styles[`flow${variant[0].toUpperCase()}${variant.slice(1)}`], styles[`flowTone${tone[0].toUpperCase()}${tone.slice(1)}`], className].filter(Boolean).join(' ')
  const isCard = variant === 'card'
  const isBackground = variant === 'background'

  return (
    <svg className={classes} viewBox={isCard ? '0 0 360 110' : isBackground ? '0 0 900 500' : '0 0 360 170'} fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="1" x2="1" y2="0" gradientUnits="objectBoundingBox">
          <stop offset="0" stopColor="currentColor" stopOpacity="0.05" />
          <stop offset="0.45" stopColor="currentColor" stopOpacity="0.86" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0.28" />
        </linearGradient>
      </defs>
      {isCard && <>
        <path className={styles.flowStrong} d="M 118 103 C 158 83, 176 28, 226 19 C 276 10, 309 39, 357 16" stroke={`url(#${gradientId})`} />
        <path className={styles.flowMedium} d="M 151 111 C 178 82, 196 61, 222 58 C 265 53, 279 88, 327 76 C 341 72, 350 65, 360 56" stroke={`url(#${gradientId})`} />
        <path className={styles.flowFaint} d="M 211 110 C 226 90, 243 83, 267 86 C 299 90, 318 107, 360 93" stroke={`url(#${gradientId})`} />
        <FlowNode x="226" y="19" opacity=".82" /><FlowNode x="222" y="58" opacity=".66" /><FlowNode x="327" y="76" opacity=".74" /><FlowNode x="267" y="86" opacity=".52" />
      </>}
      {isBackground && <>
        <path className={styles.flowStrong} d="M 180 500 C 278 386, 306 198, 470 130 C 610 72, 705 157, 900 45" stroke={`url(#${gradientId})`} />
        <path className={styles.flowMedium} d="M 315 500 C 379 364, 438 280, 534 270 C 664 257, 690 388, 900 306" stroke={`url(#${gradientId})`} />
        <path className={styles.flowFaint} d="M 502 500 C 570 401, 653 389, 738 423 C 798 447, 843 467, 900 437" stroke={`url(#${gradientId})`} />
        <FlowNode x="470" y="130" opacity=".7" /><FlowNode x="534" y="270" opacity=".56" /><FlowNode x="604" y="223" opacity=".42" /><FlowNode x="690" y="388" opacity=".62" /><FlowNode x="738" y="423" opacity=".52" /><FlowNode x="813" y="457" opacity=".38" />
      </>}
      {variant === 'route' && <>
        <path className={styles.flowStrong} d="M 16 28 C 78 28, 103 67, 164 78 C 216 87, 273 80, 348 80" stroke={`url(#${gradientId})`} />
        <path className={styles.flowMedium} d="M 16 84 C 77 84, 112 80, 164 78" stroke={`url(#${gradientId})`} />
        <path className={styles.flowFaint} d="M 16 142 C 84 142, 111 91, 164 78" stroke={`url(#${gradientId})`} />
        <FlowNode x="164" y="78" opacity=".76" /><FlowNode x="305" y="80" opacity=".55" />
      </>}
    </svg>
  )
}

function FlowNode({ x, y, opacity }: { x: string; y: string; opacity: string }) {
  return <g className={styles.flowNode} opacity={opacity}><circle cx={x} cy={y} r="5.5" /><circle cx={x} cy={y} r="2.25" /></g>
}
