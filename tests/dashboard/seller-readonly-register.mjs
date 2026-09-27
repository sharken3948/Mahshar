import Module from 'node:module'
import React from 'react'

const load = Module._load
const api = {
  id: 'ioscope',
  name: 'ioscope',
  description: '',
  category: 'Data',
  price_per_call: 0.0011,
  payment_model: 'pay-per-call',
  seller_wallet: '0x' + '11'.repeat(20),
  auth_type: 'public',
  encrypted_key: null,
  auth_param_name: null,
  endpoint_url: '',
  method: 'GET',
  example_request: null,
  example_response: null,
  score: 9,
  uptime: 100,
  created_at: '2026-01-01T00:00:00.000Z',
  is_active: true,
  verified_at: '2026-01-01T00:00:00.000Z',
}

export const world = /** @type {any} */ ({
  isConnected: true,
  myApis: [api],
  sellerEarnings: {
    total_earnings: 0.0033,
    accumulated_share: 0.00198,
    in_flight_withdrawals: 0,
    withdrawable_balance: 0.00198,
    earnings_by_api: [{ api_id: api.id, api_name: api.name, total: 0.0033, calls: 3 }],
  },
  loading: false,
  sellCallGroups: [],
  callGroups: [],
  detailsApi: null,
  detailsSellApi: null,
  editingApi: null,
  showEditModal: false,
  editForm: { name: '', category: '', description: '', endpoint_url: '', auth_type: 'public', price_per_call: '' },
  deletingApiId: null,
  deleteConfirmText: '',
  apiActionError: null,
  viewApiModal: null,
  viewApiResponse: null,
  viewApiLoading: false,
  viewApiCopied: false,
  setDetailsApi: () => {}, setDetailsSellApi: () => {}, setEditingApi: () => {}, setShowEditModal: () => {},
  setEditForm: () => {}, setDeletingApiId: () => {}, setDeleteConfirmText: () => {}, setApiActionError: () => {},
  setViewApiModal: () => {}, setViewApiCopied: () => {}, handleEditSave: async () => {}, handleDeleteConfirm: async () => {},
  toggleActive: async () => {}, handleViewApi: async () => {}, beginEditApi: async () => {},
  gatewayStats: { gatewayAvailable: '0' },
  walletUsdcRaw: 0n,
  withdrawingRaw: 0n,
  solanaConnected: false,
  solanaBalance: { usdcBalance: '0', isLoading: false, error: null },
})

Module._load = function (id, parent, main) {
  if (id.endsWith('.module.css')) return new Proxy({}, { get: (_, key) => key === '__esModule' ? false : String(key) })
  if (id === 'next/link') return 'a'
  if (id === '@rainbow-me/rainbowkit') return { ConnectButton: () => React.createElement('button', null, 'Connect wallet') }
  if (id === '../dashboard-workspace' || id === './dashboard-workspace') return { useDashboardWorkspace: () => world }
  if (id === '../dashboard-visuals' || id === './dashboard-visuals') return {
    DashboardCardHeader: ({ title }) => React.createElement('h2', null, title),
    DashboardIcon: () => null,
    UsdcUnit: () => React.createElement('span', null, 'USDC'),
  }
  if (id === '@/components/ProductPreferencesProvider') return { useProductPreferences: () => ({ formatUsdc: value => Number(value).toFixed(4) }) }
  return load.call(this, id, parent, main)
}
