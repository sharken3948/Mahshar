import 'server-only'
import lockfileJson from '../../../package-lock.json'
import { OFFICIAL_ARC_MAINNET_RPC_URL } from '@/lib/arc-network'
import { GROQ_MODEL } from '@/lib/groq-neutral'
import type { MaintenanceInventoryItem } from './types'

type Lockfile = { packages?: Record<string, { version?: string; dependencies?: Record<string, string>; dev?: boolean; resolved?: string }> }

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
  ['x402-core', 'x402 core', 'Runtime', '@x402/core', 'Payment protocol requirements, verification, and settlement.'],
  ['x402-evm', 'x402 EVM', 'Runtime', '@x402/evm', 'EVM payment protocol integration.'],
  ['mcp-server', 'MCP server SDK', 'Runtime', '@modelcontextprotocol/server', 'Marketplace MCP server transport and tools.'],
  ['mcp-core', 'MCP core SDK', 'Runtime', '@modelcontextprotocol/core', 'Protocol implementation installed through the MCP server SDK.'],
  ['next', 'Next.js', 'Runtime', 'next', 'Application framework and server runtime.'],
  ['react', 'React', 'Runtime', 'react', 'Application rendering runtime.'],
  ['wagmi', 'wagmi', 'Runtime', 'wagmi', 'Connected-wallet state and signing flows.'],
  ['viem', 'viem', 'Runtime', 'viem', 'Arc clients, typed-data verification, and transaction utilities.'],
  ['workflow', 'Workflow', 'Runtime', 'workflow', 'Durable Worker discovery workflow runtime.'],
  ['groq-sdk', 'Groq SDK', 'AI', 'groq-sdk', 'Centralized Groq API client used for bounded AI tasks.'],
] as const

const bundledLockfile = lockfileJson as unknown as Lockfile

export type AdvisoryPackage = { name: string; version: string }
export const MAX_ADVISORY_PACKAGES = 128

// Direct production dependencies plus watched SDKs, including nested versions of
// those names. This is deliberately a bounded watch, not a full dependency audit.
export function getAdvisoryScope(lockfile: Lockfile = bundledLockfile): { packages: AdvisoryPackage[]; complete: boolean } {
  const records = lockfile.packages || {}
  const names = new Set([...Object.keys(records['']?.dependencies || {}), ...PACKAGE_ITEMS.map(item => item[3])])
  const found = new Set<string>()
  const versions = new Map<string, AdvisoryPackage>()
  let complete = Boolean(records['']?.dependencies)
  for (const [path, record] of Object.entries(records)) {
    const name = path.split('node_modules/').at(-1) || ''
    if (!names.has(name) || record.dev) continue
    if (!record.version || !/^\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/.test(record.version) || !record.resolved?.startsWith('https://registry.npmjs.org/')) {
      complete = false
      continue
    }
    found.add(name)
    versions.set(`${name}@${record.version}`, { name, version: record.version })
  }
  if ([...names].some(name => !found.has(name))) complete = false
  const packages = [...versions.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
  return { packages: packages.slice(0, MAX_ADVISORY_PACKAGES), complete: complete && packages.length <= MAX_ADVISORY_PACKAGES }
}

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
      usage: 'Official retirement notices for the model used by Mahshar’s centralized Groq integration.', source_url: 'https://console.groq.com/docs/deprecations.md',
    },
    {
      id: 'cctp-notices', component: 'CCTP deprecation notices', category: 'Circle',
      current: `Bridge Kit ${installedVersion('@circle-fin/bridge-kit', lockfile)}; CCTP provider ${installedVersion('@circle-fin/provider-cctp-v2', lockfile)}`,
      package_name: null, usage: 'Bridge transfers and pending recovery; SDK versions alone do not establish route compatibility.',
      source_url: 'https://developers.circle.com/cctp/migration-from-v1-to-v2',
    },
    {
      id: 'mcp-protocol', component: 'MCP protocol releases', category: 'Runtime',
      current: `MCP core SDK ${installedVersion('@modelcontextprotocol/core', lockfile)}`,
      package_name: null, usage: 'MCP protocol negotiation and tools. Supported wire versions require separate implementation review.',
      source_url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/releases',
    },
    {
      id: 'erc-8004', component: 'ERC-8004 specification', category: 'Runtime', current: 'No pinned specification revision',
      package_name: null, usage: 'Existing Arc identity registry reader; a specification revision is not an installed package version.',
      source_url: 'https://eips.ethereum.org/EIPS/eip-8004',
    },
    {
      id: 'security-advisories', component: 'Dependency security advisories', category: 'Runtime', current: 'Deployed lockfile versions',
      package_name: null, usage: 'OSV exact-version lookup for direct production dependencies and watched SDKs, including nested versions of those names. Other transitive and development dependencies are outside this watch.',
      source_url: 'https://osv.dev/',
    },
    ...packages,
  ]
}
