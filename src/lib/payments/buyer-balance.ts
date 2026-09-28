import { formatUnits, parseUnits } from 'viem'

const USDC_DECIMALS = 6

export interface BuyerPaymentQuote {
  listedAtomic: bigint
  feeAtomic: bigint
  totalAtomic: bigint
  listed: string
  fee: string
  total: string
}

export function parseGatewayUsdc(value: string): bigint {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value)) throw new Error('Invalid Mahshar Balance')
  return parseUnits(value, USDC_DECIMALS)
}

export function buyerPaymentQuote(listedPrice: number, requiredAtomic: string): BuyerPaymentQuote {
  if (!Number.isFinite(listedPrice) || listedPrice <= 0 || !/^\d+$/.test(requiredAtomic)) {
    throw new Error('Invalid payment requirement')
  }
  const totalAtomic = BigInt(requiredAtomic)
  const listedAtomic = BigInt(Math.round(listedPrice * 10 ** USDC_DECIMALS))
  if (totalAtomic <= BigInt(0) || totalAtomic < listedAtomic) throw new Error('Invalid payment requirement')
  const feeAtomic = totalAtomic - listedAtomic
  return {
    listedAtomic,
    feeAtomic,
    totalAtomic,
    listed: formatUnits(listedAtomic, USDC_DECIMALS),
    fee: formatUnits(feeAtomic, USDC_DECIMALS),
    total: formatUnits(totalAtomic, USDC_DECIMALS),
  }
}

export function gatewayCanPay(gatewayAvailable: string, requiredAtomic: string) {
  return parseGatewayUsdc(gatewayAvailable) >= BigInt(requiredAtomic)
}

export function insufficientGatewayMessage(requiredAtomic: string) {
  const required = formatUnits(BigInt(requiredAtomic), USDC_DECIMALS)
  return `Your wallet has USDC, but Mahshar payments use your Circle Gateway balance. Fund Mahshar Balance before purchasing this API. ${required} USDC is required.`
}
