export const WITHDRAW_AUTH_DOMAIN = 'mahshar.xyz'
export const WITHDRAW_TIMESTAMP_WINDOW_SECONDS = 300

export function buildWithdrawMessage(params: {
  sellerWallet: string
  amountUsdc: string
  timestamp: string
  nonce: string
}): string {
  return [
    `domain: ${WITHDRAW_AUTH_DOMAIN}`,
    'Mahshar withdrawal authorization',
    `wallet: ${params.sellerWallet.toLowerCase()}`,
    `amount_usdc: ${params.amountUsdc}`,
    `timestamp: ${params.timestamp}`,
    `nonce: ${params.nonce}`,
  ].join('\n')
}

export function buildConfirmMessage(params: {
  sellerWallet: string
  withdrawalId: string
  timestamp: string
  nonce: string
}): string {
  return [
    `domain: ${WITHDRAW_AUTH_DOMAIN}`,
    'Mahshar withdrawal confirmation',
    `wallet: ${params.sellerWallet.toLowerCase()}`,
    `withdrawal_id: ${params.withdrawalId}`,
    `timestamp: ${params.timestamp}`,
    `nonce: ${params.nonce}`,
  ].join('\n')
}
