import 'server-only'
import lockfileJson from '../../../package-lock.json'
import { OFFICIAL_ARC_MAINNET_RPC_URL } from '@/lib/arc-balance-client'
import { GROQ_MODEL } from '@/lib/groq-neutral'
import type { MaintenanceInventoryItem } from './types'

type Lockfile = { packages?: Record<string, { version?: string }> }

const PACKAGE_ITEMS = [
  ['circle-app-kit', 'Circle App Kit', 'Circle', '@circle-fin/app-kit', 'Unified Balance operations in the wallet dashboard.'],
  ['circle-bridge-kit', 'Circle Bridge Kit / CCTP', 'Circle', '@circle-fin/bridge-kit', 'USDC bridge estimates and transfers to Arc.'],
  ['circle-unified-balance', 'Circle Unified Balance Kit', 'Circle', '@circle-fin/unified-balance-kit', 'Installed through App Kit and used for Arc deposits and spends.'],
  ['circle-gateway-provider', 'Circle Gateway provider', 'Circle', '@circle-fin/provider-gateway-v1', 'Installed through Unified Balance for Gateway routing.'],
  ['circle-cctp-provider', 'Circle CCTP provider', 'Circle', '@circle-fin/provider-cctp-v2', 'Installed through Bridge Kit and Unified Balance for CCTP routing.'],
  ['circle-solana-adapter', 'Circle Solana adapter', 'Circle', '@circle-fin/adapter-solana', 'Solana-to-Arc bridge wallet adapter.'],
  ['circle-viem-adapter', 'Circle viem adapter', 'Circle', '@circle-fin/adapter-viem-v2', 'EVM wallet adapter used by App Kit and Bridge Kit.'],
  ['circle-x402', 'Circle x402 batching', 'Circle', '@circle-fin/x402-batching', 'Arc Mainnet x402 verification, settlement, and withdrawal headers.'],
  ['circle-onramp', 'Circle Onramp Kit', 'Circle', '@circle-fin/onramp-kit', 'Fiat onramp session and widget integration.'],
  ['next', 'Next.js', 'Runtime', 'next', 'Application framework and server runtime.'],
  ['react', 'React', 'Runtime', 'react', 'Application rendering runtime.'],
  ['wagmi', 'wagmi', 'Runtime', 'wagmi', 'Connected-wallet state and signing flows.'],
  ['viem', 'viem', 'Runtime', 'viem', 'Arc clients, typed-data verification, and transaction utilities.'],
  ['workflow', 'Workflow', 'Runtime', 'workflow', 'Durable Worker discovery workflow runtime.'],
  ['groq-sdk', 'Groq SDK', 'AI', 'groq-sdk', 'Centralized Groq API client used for bounded AI tasks.'],
] as const

const bundledLockfile = lockfileJson as unknown as Lockfile

function installedVersion(packageName: string, lockfile: Lockfile): string {
  try {
    const value = lockfile.packages?.[`node_modules/${packageName}`]?.version
    return typeof value === 'string' && value.length <= 64 ? value : 'Unknown'
  } catch { return 'Unknown' }
}

export function configuredGroqModel(): string {
  return GROQ_MODEL.length <= 160 ? GROQ_MODEL : 'Invalid configured Groq model identifier'
}

function normalizedRpc(value: string | undefined): string | null {
  if (!value?.trim()) return null
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return url.origin + url.pathname.replace(/\/$/, '')
  } catch { return null }
}

function rpcRoleLabel(raw: string | undefined, fallback: string | null): string {
  if (!raw?.trim() && fallback === null) return 'not configured'
  const normalized = normalizedRpc(raw) || fallback
  if (!normalized) return 'invalid configuration'
  return normalized === OFFICIAL_ARC_MAINNET_RPC_URL.replace(/\/$/, '') ? 'official .arc.io Mainnet RPC' : 'custom Mainnet RPC'
}

export function configuredArcRpc(): { values: string[]; display: string } {
  const serverRaw = process.env.ARC_MAINNET_RPC_URL
  const browserRaw = process.env.NEXT_PUBLIC_ARC_MAINNET_RPC_URL
  const official = OFFICIAL_ARC_MAINNET_RPC_URL.replace(/\/$/, '')
  const server = normalizedRpc(serverRaw)
  const browser = normalizedRpc(browserRaw) || official
  return {
    values: [...new Set([server, browser].filter((value): value is string => Boolean(value)))],
    display: `Server role: ${rpcRoleLabel(serverRaw, null)}; browser role: ${rpcRoleLabel(browserRaw, official)}`,
  }
}

export function getMaintenanceInventory(lockfile: Lockfile = bundledLockfile): MaintenanceInventoryItem[] {
  const packages = PACKAGE_ITEMS.map(([id, component, category, packageName, usage]) => ({
    id,
    component,
    category,
    current: installedVersion(packageName, lockfile),
    package_name: packageName,
    usage,
    source_url: `https://www.npmjs.com/package/${packageName}`,
  })) satisfies MaintenanceInventoryItem[]
  const rpc = configuredArcRpc()
  return [
    {
      id: 'arc-node', component: 'Arc node releases', category: 'Arc', current: 'RPC consumer (no Mahshar node)', package_name: null,
      usage: 'Mahshar consumes Arc Mainnet RPC; it does not operate an Arc node.', source_url: 'https://github.com/circlefin/arc-node/releases',
    },
    {
      id: 'arc-rpc', component: 'Arc operational notices', category: 'Arc', current: rpc.display, package_name: null,
      usage: 'Arc Mainnet RPC availability and endpoint notices relevant to the configured runtime.', source_url: 'https://status.arc.io/',
    },
    {
      id: 'groq-model', component: 'Configured Groq model', category: 'AI', current: configuredGroqModel(), package_name: null,
      usage: 'Configured model used by the centralized server-only Groq integration.', source_url: 'https://console.groq.com/docs/models',
    },
    {
      id: 'groq-deprecations', component: 'Groq model deprecations', category: 'AI', current: configuredGroqModel(), package_name: null,
      usage: 'Official retirement notices for the model used by Mahshar’s centralized Groq integration.', source_url: 'https://console.groq.com/docs/deprecations',
    },
    ...packages,
  ]
}
