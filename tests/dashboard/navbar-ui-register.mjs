import Module from 'node:module'
import React from 'react'

const load = Module._load

export const walletState = {
  accountActions: 0,
  address: `0x${'11'.repeat(20)}`,
  chainActions: 0,
  connectActions: 0,
  connected: true,
  unsupported: false,
}

const cssClasses = new Proxy({}, { get: (_target, property) => String(property) })

Module._load = function(id, parent, main) {
  if (id.endsWith('.css')) return { __esModule: true, default: cssClasses }
  if (id === 'next/link') {
    return { __esModule: true, default: 'a' }
  }
  if (id === '@rainbow-me/rainbowkit') {
    function ConnectButton() {}
    ConnectButton.Custom = ({ children }) => children({
      account: walletState.connected ? {
        address: walletState.address,
        displayName: 'display-name-must-not-render.eth',
        ensAvatar: undefined,
      } : undefined,
      chain: walletState.connected ? {
        hasIcon: true,
        iconUrl: '/chain-should-not-render.svg',
        id: 5042,
        name: 'Arc Mainnet',
        unsupported: walletState.unsupported,
      } : undefined,
      mounted: true,
      openAccountModal: () => { walletState.accountActions += 1 },
      openChainModal: () => { walletState.chainActions += 1 },
      openConnectModal: () => { walletState.connectActions += 1 },
    })
    return { ConnectButton }
  }
  if (id === 'wagmi') {
    return { useAccount: () => ({ address: walletState.address, connector: { icon: '/provider-icon.svg' }, isConnected: walletState.connected }) }
  }
  if (id === './MahsharLogo') {
    return { MahsharLogo: ({ variant }) => React.createElement('a', { 'data-variant': variant, href: '/' }, 'Mahshar') }
  }
  if (id === './ProductPreferencesProvider') {
    return { useProductPreferences: () => ({ formatUsdc: value => String(value) }) }
  }
  if (id === '@/hooks/useVisibilityRefresh') return { useVisibilityRefresh: () => {} }
  if (id === '@/hooks/useWalletAuthorization') return { useWalletAuthorization: () => ({ request: async () => Response.json({ gatewayAvailable: '0' }) }) }
  return load.call(this, id, parent, main)
}
