'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { formatUnits } from 'viem'
import { DEFAULT_PRODUCT_PREFERENCES, PRODUCT_PREFERENCES_STORAGE_KEY, type NotificationPreference, type ProductPreferences } from '@/lib/product-preferences'

export { BRIDGE_ACTIVITY_PREFIX } from '@/lib/product-preferences'
export type { NotificationPreference, UsdcDecimals } from '@/lib/product-preferences'

interface ProductPreferencesContextValue {
  preferences: ProductPreferences
  updatePreferences: (patch: Partial<ProductPreferences>) => void
  setNotification: (name: NotificationPreference, enabled: boolean) => void
  formatUsdc: (value: string | number | bigint, atomic?: boolean) => string
}

const Context = createContext<ProductPreferencesContextValue | null>(null)

function storedPreferences(): ProductPreferences {
  try {
    const saved = JSON.parse(localStorage.getItem(PRODUCT_PREFERENCES_STORAGE_KEY) ?? '{}') as Partial<ProductPreferences>
    const decimals = saved.usdcDecimals
    return {
      ...DEFAULT_PRODUCT_PREFERENCES,
      ...saved,
      usdcDecimals: decimals === 2 || decimals === 4 || decimals === 6 ? decimals : DEFAULT_PRODUCT_PREFERENCES.usdcDecimals,
      notifications: { ...DEFAULT_PRODUCT_PREFERENCES.notifications, ...(saved.notifications ?? {}) },
    }
  } catch { return DEFAULT_PRODUCT_PREFERENCES }
}

export function ProductPreferencesProvider({ children }: { children: React.ReactNode }) {
  const [preferences, setPreferences] = useState<ProductPreferences>(DEFAULT_PRODUCT_PREFERENCES)
  const [loaded, setLoaded] = useState(false)
  useEffect(() => { setPreferences(storedPreferences()); setLoaded(true) }, [])
  useEffect(() => {
    if (!loaded) return
    try { localStorage.setItem(PRODUCT_PREFERENCES_STORAGE_KEY, JSON.stringify(preferences)) } catch { /* Preferences remain usable for this tab. */ }
  }, [loaded, preferences])

  const updatePreferences = useCallback((patch: Partial<ProductPreferences>) => {
    setPreferences(current => ({ ...current, ...patch }))
  }, [])
  const setNotification = useCallback((name: NotificationPreference, enabled: boolean) => {
    setPreferences(current => ({ ...current, notifications: { ...current.notifications, [name]: enabled } }))
  }, [])
  const formatUsdc = useCallback((value: string | number | bigint, atomic = false) => {
    const decimal = typeof value === 'bigint' ? (atomic ? formatUnits(value, 6) : value.toString()) : String(value)
    const numeric = Number(decimal)
    return Number.isFinite(numeric) ? numeric.toFixed(preferences.usdcDecimals) : '—'
  }, [preferences.usdcDecimals])
  const value = useMemo(() => ({ preferences, updatePreferences, setNotification, formatUsdc }), [preferences, updatePreferences, setNotification, formatUsdc])
  return <Context.Provider value={value}>{children}</Context.Provider>
}

export function useProductPreferences() {
  const value = useContext(Context)
  if (!value) throw new Error('useProductPreferences must be used within ProductPreferencesProvider')
  return value
}

export function sendLocalNotification(title: string, body: string) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  new Notification(title, { body, icon: '/logo.png' })
}
