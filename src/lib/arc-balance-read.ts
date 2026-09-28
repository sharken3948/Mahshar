import { getAddress, type Address } from 'viem'

export const ARC_BALANCE_CACHE_MS = 4_000
export const ARC_BALANCE_COOLDOWN_MS = 8_000
export const ARC_BALANCE_FAILURE_THRESHOLD = 2
export const ARC_BALANCE_MAX_CACHE_ENTRIES = 256

export type ArcBalanceSourceName = 'configured-rpc' | 'official-rpc' | 'wallet-provider' | 'server-fallback'
export type ArcBalanceStatus = 'unknown' | 'fresh' | 'stale'

export interface ArcBalanceSnapshot {
  wallet: Address
  value: bigint | undefined
  status: ArcBalanceStatus
  source?: ArcBalanceSourceName
  updatedAt?: number
}

export interface ArcBalanceSource {
  name: ArcBalanceSourceName
  read: (wallet: Address) => Promise<bigint>
  attempts?: number
}

interface CacheEntry {
  value: bigint
  source: ArcBalanceSourceName
  updatedAt: number
  expiresAt: number
}

interface SourceHealth {
  consecutiveFailures: number
  cooldownUntil: number
  lastSuccessAt?: number
  lastLatencyMs?: number
}

export interface ArcBalanceReaderOptions {
  now?: () => number
  cacheMs?: number
  cooldownMs?: number
  failureThreshold?: number
  maxCacheEntries?: number
}

export class ArcBalanceReader {
  private readonly cache = new Map<string, CacheEntry>()
  private readonly inFlight = new Map<string, Promise<ArcBalanceSnapshot>>()
  private readonly health = new Map<ArcBalanceSourceName, SourceHealth>()
  private readonly listeners = new Map<string, Set<(snapshot: ArcBalanceSnapshot) => void>>()
  private readonly now: () => number
  private readonly cacheMs: number
  private readonly cooldownMs: number
  private readonly failureThreshold: number
  private readonly maxCacheEntries: number

  constructor(options: ArcBalanceReaderOptions = {}) {
    this.now = options.now ?? Date.now
    this.cacheMs = options.cacheMs ?? ARC_BALANCE_CACHE_MS
    this.cooldownMs = options.cooldownMs ?? ARC_BALANCE_COOLDOWN_MS
    this.failureThreshold = options.failureThreshold ?? ARC_BALANCE_FAILURE_THRESHOLD
    this.maxCacheEntries = options.maxCacheEntries ?? ARC_BALANCE_MAX_CACHE_ENTRIES
  }

  private key(wallet: Address) {
    return getAddress(wallet).toLowerCase()
  }

  snapshot(wallet: Address): ArcBalanceSnapshot {
    const normalized = getAddress(wallet)
    const cached = this.cache.get(this.key(normalized))
    if (!cached) return { wallet: normalized, value: undefined, status: 'unknown' }
    return {
      wallet: normalized,
      value: cached.value,
      status: cached.expiresAt > this.now() ? 'fresh' : 'stale',
      source: cached.source,
      updatedAt: cached.updatedAt,
    }
  }

  subscribe(wallet: Address, listener: (snapshot: ArcBalanceSnapshot) => void) {
    const key = this.key(wallet)
    const listeners = this.listeners.get(key) ?? new Set()
    listeners.add(listener)
    this.listeners.set(key, listeners)
    return () => {
      listeners.delete(listener)
      if (!listeners.size) this.listeners.delete(key)
    }
  }

  invalidate(wallet?: Address) {
    if (wallet) {
      const entry = this.cache.get(this.key(wallet))
      if (entry) entry.expiresAt = 0
      return
    }
    for (const entry of this.cache.values()) entry.expiresAt = 0
  }

  sourceHealth(name: ArcBalanceSourceName) {
    return { ...(this.health.get(name) ?? { consecutiveFailures: 0, cooldownUntil: 0 }) }
  }

  async read(wallet: Address, sources: readonly ArcBalanceSource[], options: { force?: boolean } = {}): Promise<ArcBalanceSnapshot> {
    const normalized = getAddress(wallet)
    const key = this.key(normalized)
    const existing = this.inFlight.get(key)
    if (existing) return existing

    const cached = this.cache.get(key)
    if (!options.force && cached && cached.expiresAt > this.now()) return this.snapshot(normalized)
    if (options.force && cached) cached.expiresAt = 0

    const request = this.readSources(normalized, sources).finally(() => {
      if (this.inFlight.get(key) === request) this.inFlight.delete(key)
    })
    this.inFlight.set(key, request)
    return request
  }

  private async readSources(wallet: Address, sources: readonly ArcBalanceSource[]): Promise<ArcBalanceSnapshot> {
    const startedAt = this.now()
    const available = sources.filter(source => (this.health.get(source.name)?.cooldownUntil ?? 0) <= startedAt)

    for (const source of available) {
      const attempts = Math.max(1, Math.min(2, source.attempts ?? 1))
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const attemptStartedAt = this.now()
        try {
          const value = await source.read(wallet)
          if (typeof value !== 'bigint' || value < BigInt(0)) throw new Error('Invalid Arc balance result')
          const now = this.now()
          this.health.set(source.name, {
            consecutiveFailures: 0,
            cooldownUntil: 0,
            lastSuccessAt: now,
            lastLatencyMs: Math.max(0, now - attemptStartedAt),
          })
          const entry: CacheEntry = { value, source: source.name, updatedAt: now, expiresAt: now + this.cacheMs }
          if (!this.cache.has(this.key(wallet)) && this.cache.size >= this.maxCacheEntries) {
            const evictable = [...this.cache.keys()].find(key => !this.listeners.has(key)) ?? this.cache.keys().next().value
            if (evictable) this.cache.delete(evictable)
          }
          this.cache.set(this.key(wallet), entry)
          const snapshot = this.snapshot(wallet)
          this.emit(snapshot)
          return snapshot
        } catch {
          if (attempt + 1 < attempts) continue
          const previous = this.health.get(source.name)
          const failures = (previous?.consecutiveFailures ?? 0) + 1
          this.health.set(source.name, {
            ...previous,
            consecutiveFailures: failures,
            cooldownUntil: failures >= this.failureThreshold ? this.now() + this.cooldownMs : 0,
          })
        }
      }
    }

    const snapshot = this.snapshot(wallet)
    this.emit(snapshot)
    return snapshot
  }

  private emit(snapshot: ArcBalanceSnapshot) {
    for (const listener of this.listeners.get(this.key(snapshot.wallet)) ?? []) listener(snapshot)
  }
}

export const arcBalanceReader = new ArcBalanceReader()
