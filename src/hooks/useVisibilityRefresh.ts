'use client'

import { useEffect, useRef } from 'react'

export const REFRESH_INTERVAL_MS = 60_000

/** One visibility-aware timer for a logical data group. The caller owns initial loading. */
export function useVisibilityRefresh(refresh: () => Promise<unknown>, enabled = true) {
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh

  useEffect(() => {
    if (!enabled) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const schedule = () => {
      if (disposed || document.visibilityState !== 'visible') return
      clearTimeout(timer)
      timer = setTimeout(() => { void runAndSchedule() }, REFRESH_INTERVAL_MS)
    }
    const runAndSchedule = async () => {
      if (disposed || document.visibilityState !== 'visible') return
      try { await refreshRef.current() } finally { schedule() }
    }
    const onVisibilityChange = () => {
      clearTimeout(timer)
      if (document.visibilityState === 'visible') void runAndSchedule()
    }

    schedule()
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      disposed = true
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [enabled])
}
