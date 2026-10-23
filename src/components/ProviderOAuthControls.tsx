'use client'

import { useState } from 'react'
import { useMarketplaceSession } from '@/components/MarketplaceSessionProvider'

/** Only consent URLs and connection status cross the browser boundary. */
export function ProviderOAuthControls({ apiId, onConnectionChange }: {
  apiId: string
  onConnectionChange?: () => Promise<void>
}) {
  const { request: marketplaceFetch, sensitiveRequest } = useMarketplaceSession()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('Connect the provider account, then analyze and verify this listing.')
  async function action(method: 'POST' | 'DELETE' | 'GET') {
    setBusy(true)
    try {
      const response = await (method === 'POST' ? sensitiveRequest : marketplaceFetch)(`/api/provider-oauth/${encodeURIComponent(apiId)}`, { method })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? 'Provider connection unavailable')
      if (data.authorization_url) { window.location.assign(data.authorization_url); return }
      if (method !== 'GET') await onConnectionChange?.()
      setMessage(method === 'DELETE' ? `Disconnected locally. ${data.provider_revoked ? 'Provider revocation completed.' : 'Revoke the app at the provider if needed.'}`
        : method === 'POST' ? 'Client credentials enabled. Analyze to acquire a token.' : `Provider account: ${data.status} (${data.account_mode}).`)
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Provider connection unavailable') }
    finally { setBusy(false) }
  }
  return <div>
    <p role="status">{message}</p>
    <button type="button" disabled={busy} onClick={() => void action('POST')}>Connect provider</button>{' '}
    <button type="button" disabled={busy} onClick={() => void action('GET')}>Check connection</button>{' '}
    <button type="button" disabled={busy} onClick={() => void action('DELETE')}>Disconnect provider</button>
  </div>
}
