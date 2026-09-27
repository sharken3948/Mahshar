const SOLANA_WALLET_ROUTES = new Set([
  '/dashboard',
  '/dashboard/solana',
  '/dashboard/wallet/bridge',
])

export function shouldAutoConnectSolanaWallet(pathname: string): boolean {
  return SOLANA_WALLET_ROUTES.has(pathname)
}
