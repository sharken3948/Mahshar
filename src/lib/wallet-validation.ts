import { getAddress, isAddress } from 'viem'

// H7: accepts all-lowercase and correctly checksummed (EIP-55) addresses;
// rejects mixed-case with an invalid checksum (catches single-char typos).
export function isValidWalletAddress(address: string): boolean {
  if (!isAddress(address, { strict: false })) return false
  if (address !== address.toLowerCase()) {
    try {
      getAddress(address)
    } catch {
      return false
    }
  }
  return true
}
