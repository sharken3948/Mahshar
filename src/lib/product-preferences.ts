export type UsdcDecimals = 2 | 4 | 6
export type NotificationPreference = 'bridgeCompleted' | 'bridgeFailed' | 'sellerSale' | 'withdrawalCompleted'

export interface ProductPreferences {
  usdcDecimals: UsdcDecimals
  showSmallBalances: boolean
  fundedChainsFirst: boolean
  autoRefreshBalances: boolean
  notifications: Record<NotificationPreference, boolean>
}

export const PRODUCT_PREFERENCES_STORAGE_KEY = 'mahshar:product-preferences:v1'
export const BRIDGE_ACTIVITY_PREFIX = 'mahshar:bridge-activity:v1:'
export const DEFAULT_PRODUCT_PREFERENCES: ProductPreferences = {
  usdcDecimals: 4,
  showSmallBalances: true,
  fundedChainsFirst: true,
  autoRefreshBalances: true,
  notifications: { bridgeCompleted: false, bridgeFailed: false, sellerSale: false, withdrawalCompleted: false },
}
