import 'server-only'

import { getAddress, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const PRIVATE_KEY_PATTERN = /^0x[0-9a-f]{64}$/i

export class PlatformWalletConfigurationError extends Error {
  readonly code: 'invalid_platform_wallet_configuration' | 'platform_wallet_configuration_mismatch'

  constructor(code: PlatformWalletConfigurationError['code']) {
    super(code === 'platform_wallet_configuration_mismatch'
      ? 'Platform wallet configuration mismatch'
      : 'Platform wallet configuration is invalid')
    this.name = 'PlatformWalletConfigurationError'
    this.code = code
  }
}

export type VerifiedPlatformWalletConfiguration = {
  address: Address
  privateKey: Hex
}

/**
 * Resolves the financial platform-wallet pair and proves that its public
 * address belongs to its signer. Errors are deliberately bounded and never
 * include configuration values.
 */
export function verifyPlatformWalletConfiguration(input: {
  address?: string
  privateKey?: string
} = {}): VerifiedPlatformWalletConfiguration {
  const configuredAddress = input.address ?? process.env.PLATFORM_WALLET_ADDRESS
  const configuredPrivateKey = input.privateKey ?? process.env.PLATFORM_WALLET_PRIVATE_KEY

  if (!configuredAddress?.trim() || !configuredPrivateKey?.trim() ||
    !PRIVATE_KEY_PATTERN.test(configuredPrivateKey.trim())) {
    throw new PlatformWalletConfigurationError('invalid_platform_wallet_configuration')
  }

  try {
    const address = getAddress(configuredAddress.trim())
    const privateKey = configuredPrivateKey.trim() as Hex
    const signerAddress = getAddress(privateKeyToAccount(privateKey).address)
    if (signerAddress !== address) {
      throw new PlatformWalletConfigurationError('platform_wallet_configuration_mismatch')
    }
    return { address, privateKey }
  } catch (error) {
    if (error instanceof PlatformWalletConfigurationError) throw error
    throw new PlatformWalletConfigurationError('invalid_platform_wallet_configuration')
  }
}
