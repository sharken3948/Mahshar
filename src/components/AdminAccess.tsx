'use client'

import { createContext, useContext } from 'react'
import { useWalletAuthorization } from '@/hooks/useWalletAuthorization'

const AdminRequest = createContext<((url: string, init?: RequestInit) => Promise<Response>) | null>(null)

export function useAdminRequest() {
  const request = useContext(AdminRequest)
  if (!request) throw new Error('Admin authorization provider missing')
  return request
}

/**
 * Admin pages render normally. Each sensitive read or mutation is authorized
 * independently by the connected wallet and then checked against the server's
 * administrator allowlist.
 */
export function AdminAccess({ children }: { children: React.ReactNode }) {
  const { request } = useWalletAuthorization()
  return <AdminRequest.Provider value={request}>{children}</AdminRequest.Provider>
}
