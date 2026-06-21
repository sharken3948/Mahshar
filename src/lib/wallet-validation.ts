const WALLET_RE = /^0x[a-fA-F0-9]{40}$/

export function isValidWalletAddress(address: string): boolean {
  return WALLET_RE.test(address)
}
