'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { getAccount } from '@wagmi/core'
import { useAccount, useConfig, useSignTypedData, useSwitchChain } from 'wagmi'
import type { Address, EIP1193Provider, Hex } from 'viem'
import { OPERATION_AUTH_DOMAIN, OPERATION_AUTH_HEADER, OPERATION_AUTH_SECONDS, OPERATION_AUTH_TYPES,
  authorizationMessage, encodeAuthorizationProof, normalizedWallet, requestPayload } from '@/lib/marketplace/operation-authorization'
import { LOGIN_AUTH_DOMAIN, LOGIN_AUTH_TYPES, loginMessage } from '@/lib/marketplace/session-auth'
import { ARC_MAINNET_CHAIN_ID } from '@/lib/arc-network'
import { numericChainId, providerChainId, waitForProviderChain, walletChainErrorMessage } from '@/lib/wallet-chain-transition'

type SessionStatus = 'disconnected' | 'checking' | 'signing' | 'authenticated' | 'unauthenticated' | 'error'
type NetworkStatus = 'disconnected' | 'checking' | 'switching' | 'ready' | 'required'
type SessionCheckResult = 'authenticated' | 'unauthenticated' | 'unavailable'
type LoginResult = { authenticated: boolean; rejected: boolean; error: string | null }
type Coordinated<T> = { generation: number; promise: Promise<T> }
type LoginAttempt = { generation: number; active: boolean }
type SessionContextValue = {
  status: SessionStatus
  networkStatus: NetworkStatus
  wallet: string | null
  error: string | null
  request: (input: string, init?: RequestInit) => Promise<Response>
  sensitiveRequest: (input: string, init?: RequestInit) => Promise<Response>
  authenticate: () => Promise<boolean>
}

const SessionContext = createContext<SessionContextValue | null>(null)
const loginInFlight = new Map<string, Coordinated<LoginResult>>()
const checkInFlight = new Map<string, Coordinated<SessionCheckResult>>()
const chainInFlight = new Map<string, Coordinated<{ ready: boolean; rejected: boolean; error: string | null }>>()
const automaticChainAttempts = new Set<string>()
// The server session belongs to the browser, not to a particular React mount.
// Keep the successful hand-off visible across Strict Mode remounts and to every
// consumer before the POST /api/auth/session promise is released.
let establishedSessionWallet: string | null = null
let establishedSessionGeneration = 0
let signatureQueue: Promise<void> = Promise.resolve()
let coordinatorWallet: string | null = null
let coordinatorGeneration = 0
const DEFAULT_AUTH_STAGE_TIMEOUT_MS = 30_000
let authStageTimeoutMs = DEFAULT_AUTH_STAGE_TIMEOUT_MS
const responseControllers = new WeakMap<Response, AbortController>()

class AuthTimeoutError extends Error {
  constructor(stage: string) {
    super(`${stage} timed out`)
    this.name = 'AuthTimeoutError'
  }
}

function coordinateWallet(wallet: string | null) {
  if (coordinatorWallet !== wallet) {
    coordinatorWallet = wallet
    coordinatorGeneration += 1
  }
  return coordinatorGeneration
}

function invalidateCoordinator(wallet: string) {
  if (coordinatorWallet === wallet) coordinatorGeneration += 1
  return coordinatorGeneration
}

function bounded<T>(operation: Promise<T>, stage: string, onTimeout?: () => void): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      onTimeout?.()
      reject(new AuthTimeoutError(stage))
    }, authStageTimeoutMs)
    if (typeof timeoutId === 'object' && 'unref' in timeoutId) timeoutId.unref()
  })
  return Promise.race([operation, timeout]).finally(() => {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
  })
}

function boundedFetch(input: RequestInfo | URL, init: RequestInit, stage: string) {
  const controller = new AbortController()
  return bounded(fetch(input, { ...init, signal: controller.signal }), stage, () => controller.abort())
    .then(response => { responseControllers.set(response, controller); return response })
}

/** Test isolation for the module-level browser-session coordinator. */
export function resetMarketplaceSessionCoordinatorForTests() {
  loginInFlight.clear()
  checkInFlight.clear()
  chainInFlight.clear()
  automaticChainAttempts.clear()
  establishedSessionWallet = null
  establishedSessionGeneration = 0
  signatureQueue = Promise.resolve()
  coordinatorWallet = null
  coordinatorGeneration = 0
  authStageTimeoutMs = DEFAULT_AUTH_STAGE_TIMEOUT_MS
}

export function setMarketplaceSessionTimeoutForTests(milliseconds: number) {
  authStageTimeoutMs = milliseconds
}

function serializeSignature<T>(sign: () => Promise<T>, isCurrent: () => boolean) {
  const previous = signatureQueue
  let release!: () => void
  const ownOperation = new Promise<void>(resolve => { release = resolve })
  // Keep the global tail behind both the previous real wallet operation and
  // this reserved turn. Timing out a caller must not pretend that an
  // underlying, non-cancellable wallet prompt has settled.
  signatureQueue = previous.catch(() => undefined).then(() => ownOperation)
  let walletOperationStarted = false
  return (async () => {
    try {
      await bounded(previous, 'Wallet signature queue')
      if (!isCurrent()) throw new Error('Wallet changed')
      let walletOperation: Promise<T>
      try { walletOperation = Promise.resolve(sign()) }
      catch (error) { release(); throw error }
      walletOperationStarted = true
      void walletOperation.then(release, release)
      return await bounded(walletOperation, 'Wallet signature')
    } finally {
      // If this turn expired while waiting, release its own empty reservation.
      // The chained tail still cannot resolve until `previous` really settles.
      if (!walletOperationStarted) release()
    }
  })()
}

function boundedResponseJson(response: Response, stage: string) {
  return bounded(response.json(), stage, () => {
    responseControllers.get(response)?.abort()
    void response.body?.cancel().catch(() => undefined)
  }).finally(() => { responseControllers.delete(response) })
}

function userRejected(error: unknown) {
  let candidate = error
  for (let depth = 0; depth < 4 && candidate && typeof candidate === 'object'; depth += 1) {
    if ('code' in candidate && Number(candidate.code) === 4001) return true
    candidate = 'cause' in candidate ? candidate.cause : null
  }
  return false
}

function randomOperationNonce(): Hex {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return `0x${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`
}

export function MarketplaceSessionProvider({ children }: { children: React.ReactNode }) {
  const { address, connector } = useAccount()
  const config = useConfig()
  const { signTypedDataAsync } = useSignTypedData()
  const { switchChainAsync } = useSwitchChain()
  const wallet = address?.toLowerCase() ?? null
  const currentWallet = useRef(wallet)
  currentWallet.current = wallet
  const previousWallet = useRef<string | null>(null)
  const authenticatedWallet = useRef<string | null>(null)
  const rejectedWallet = useRef<string | null>(null)
  const initializedSession = useRef<{ wallet: string; result: SessionCheckResult } | null>(null)
  const [status, setStatus] = useState<SessionStatus>(wallet ? 'checking' : 'disconnected')
  const [networkStatus, setNetworkStatus] = useState<NetworkStatus>(wallet ? 'checking' : 'disconnected')
  const [error, setError] = useState<string | null>(null)
  const statusRef = useRef(status)
  statusRef.current = status

  const currentAttempt = useCallback((requestedWallet: string, generation: number) =>
    coordinatorWallet === requestedWallet && coordinatorGeneration === generation &&
    currentWallet.current === requestedWallet && getAccount(config).address?.toLowerCase() === requestedWallet, [config])

  const ensureArcMainnet = useCallback(async (requestedWallet: string, explicit: boolean, generation = coordinatorGeneration) => {
    if (!currentAttempt(requestedWallet, generation)) return false
    const activeConnector = getAccount(config).connector ?? connector
    let provider: EIP1193Provider | null | undefined
    try {
      provider = await bounded(Promise.resolve(activeConnector?.getProvider()), 'Wallet provider') as EIP1193Provider | null | undefined
    } catch {
      provider = null
    }
    if (!provider) {
      if (currentAttempt(requestedWallet, generation)) {
        setNetworkStatus('required')
        setStatus('error')
        setError('Wallet network could not be checked. Reconnect your wallet and try again.')
      }
      return false
    }

    const activeChain = await bounded(providerChainId(provider), 'Wallet network check').catch(() => null)
    if (!currentAttempt(requestedWallet, generation)) return false
    if (activeChain === ARC_MAINNET_CHAIN_ID) {
      automaticChainAttempts.delete(requestedWallet)
      if (currentWallet.current === requestedWallet) setNetworkStatus('ready')
      return true
    }

    const existing = chainInFlight.get(requestedWallet)
    if (existing?.generation === generation) {
      const result = await existing.promise
      if (currentAttempt(requestedWallet, generation)) {
        setNetworkStatus(result.ready ? 'ready' : 'required')
        if (!result.ready) {
          setStatus(result.rejected ? 'unauthenticated' : 'error')
          setError(result.error)
        }
      }
      return result.ready
    }
    if (!explicit && automaticChainAttempts.has(requestedWallet)) {
      if (currentAttempt(requestedWallet, generation)) {
        setNetworkStatus('required')
        setStatus('unauthenticated')
        setError('Switch to Arc Mainnet to continue.')
      }
      return false
    }

    automaticChainAttempts.add(requestedWallet)
    if (currentWallet.current === requestedWallet) {
      setNetworkStatus('switching')
      setStatus('checking')
      setError(null)
    }
    const transition = (async () => {
      try {
        await bounded(switchChainAsync({ chainId: ARC_MAINNET_CHAIN_ID, connector: activeConnector }), 'Wallet network switch')
        const settled = await bounded(waitForProviderChain(provider, ARC_MAINNET_CHAIN_ID), 'Wallet network confirmation')
        if (!settled.confirmed) throw new Error('Wallet provider did not confirm Arc Mainnet in time')
        automaticChainAttempts.delete(requestedWallet)
        return { ready: true, rejected: false, error: null }
      } catch (chainError) {
        const rejected = userRejected(chainError)
        return { ready: false, rejected, error: rejected
          ? 'Arc Mainnet switch was cancelled. Switch networks when you are ready to continue.'
          : walletChainErrorMessage(chainError, 'Arc Mainnet') }
      }
    })().finally(() => {
      if (chainInFlight.get(requestedWallet)?.promise === transition) chainInFlight.delete(requestedWallet)
    })
    chainInFlight.set(requestedWallet, { generation, promise: transition })
    const result = await transition
    if (!currentAttempt(requestedWallet, generation)) return false
    setNetworkStatus(result.ready ? 'ready' : 'required')
    if (!result.ready) {
      setStatus(result.rejected ? 'unauthenticated' : 'error')
      setError(result.error)
    }
    return result.ready
  }, [config, connector, currentAttempt, switchChainAsync])

  const checkSession = useCallback((requestedWallet: string, generation: number) => {
    const existing = checkInFlight.get(requestedWallet)
    if (existing?.generation === generation) return existing.promise
    const request = boundedFetch(`/api/auth/session?wallet=${encodeURIComponent(requestedWallet)}`, {
      credentials: 'same-origin', cache: 'no-store',
    }, 'Wallet session check').then(async response => {
      if (response.status === 401) return 'unauthenticated' as const
      if (!response.ok) return 'unavailable' as const
      const body = await boundedResponseJson(response, 'Wallet session response').catch(() => null) as { authenticated?: boolean; wallet?: string } | null
      if (!body) return 'unavailable' as const
      return body.authenticated === true && body.wallet?.toLowerCase() === requestedWallet
        ? 'authenticated' as const : 'unauthenticated' as const
    }).catch(() => 'unavailable' as const).finally(() => {
      if (checkInFlight.get(requestedWallet)?.promise === request) checkInFlight.delete(requestedWallet)
    })
    checkInFlight.set(requestedWallet, { generation, promise: request })
    return request
  }, [])

  const initializeSession = useCallback(async (requestedWallet: string, generation: number): Promise<SessionCheckResult> => {
    if (establishedSessionWallet === requestedWallet) {
      authenticatedWallet.current = requestedWallet
      initializedSession.current = { wallet: requestedWallet, result: 'authenticated' }
      setStatus('authenticated')
      setError(null)
      return 'authenticated'
    }
    if (authenticatedWallet.current === requestedWallet) {
      setStatus('authenticated')
      setError(null)
      return 'authenticated'
    }
    if (initializedSession.current?.wallet === requestedWallet) return initializedSession.current.result
    if (currentWallet.current === requestedWallet) {
      setStatus('checking')
      setError(null)
    }
    const result = await checkSession(requestedWallet, generation)
    if (!currentAttempt(requestedWallet, generation)) {
      return 'unavailable'
    }
    initializedSession.current = { wallet: requestedWallet, result }
    if (result === 'authenticated') {
      establishedSessionWallet = requestedWallet
      authenticatedWallet.current = requestedWallet
      rejectedWallet.current = null
      setStatus('authenticated')
      setError(null)
    } else if (result === 'unavailable') {
      setStatus('error')
      setError('Wallet session could not be checked. Try again when the service is available.')
    }
    return result
  }, [checkSession, currentAttempt])

  const performLogin = useCallback((requestedWallet: string, generation: number): Promise<LoginResult> => {
    const existing = loginInFlight.get(requestedWallet)
    if (existing?.generation === generation) return existing.promise
    const attempt: LoginAttempt = { generation, active: true }
    const ownsAttempt = () => attempt.active && currentAttempt(requestedWallet, attempt.generation)
    const request = (async (): Promise<LoginResult> => {
      try {
        if (!ownsAttempt()) throw new Error('Wallet changed')
        if (!await ensureArcMainnet(requestedWallet, false, generation)) throw new Error('Switch to Arc Mainnet to sign in.')
        const challengeResponse = await boundedFetch('/api/auth/challenge', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ wallet: requestedWallet }),
        }, 'Wallet login challenge')
        const candidate = await boundedResponseJson(challengeResponse, 'Wallet challenge response').catch(() => null) as {
          challenge_id?: string; wallet?: string; nonce?: Hex; issued_at?: number; deadline?: number;
          origin?: string; error?: string
        } | null
        if (!challengeResponse.ok || !candidate?.challenge_id || candidate.wallet !== requestedWallet
          || !candidate.nonce || !Number.isSafeInteger(candidate.issued_at) || !Number.isSafeInteger(candidate.deadline)
          || candidate.origin !== window.location.origin) {
          throw new Error(candidate?.error ?? 'Wallet login challenge unavailable')
        }
        const challenge = candidate as { challenge_id: string; wallet: string; nonce: Hex; issued_at: number;
          deadline: number; origin: string }
        const signature = await serializeSignature(async () => {
          if (!ownsAttempt()) throw new Error('Wallet changed')
          setStatus('signing')
          try {
            return await signTypedDataAsync({ account: requestedWallet as Address, domain: LOGIN_AUTH_DOMAIN,
              types: LOGIN_AUTH_TYPES, primaryType: 'MahsharLogin', message: loginMessage({
                wallet: requestedWallet as Address, origin: challenge.origin, nonce: challenge.nonce,
                issuedAt: challenge.issued_at, deadline: challenge.deadline,
              }) })
          } finally {
            // The wallet prompt is over. Session creation/recovery is a passive
            // check and must never leave the header claiming a signature is active.
            if (ownsAttempt() && establishedSessionWallet !== requestedWallet) {
              setStatus('checking')
            }
          }
        }, ownsAttempt)
        if (!ownsAttempt()) throw new Error('Wallet changed')
        const response = await boundedFetch('/api/auth/session', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
            challenge_id: challenge.challenge_id, wallet: requestedWallet, nonce: challenge.nonce,
            issued_at: challenge.issued_at, deadline: challenge.deadline, signature,
          }),
        }, 'Wallet session creation')
        const result = await boundedResponseJson(response, 'Wallet session creation response').catch(() => null) as { authenticated?: boolean; wallet?: string; error?: string } | null
        if (!response.ok || result?.authenticated !== true || result.wallet?.toLowerCase() !== requestedWallet) {
          throw new Error(result?.error ?? 'Wallet session could not be created')
        }
        // Publish success before resolving loginInFlight. This closes the gap
        // where another consumer/remount could observe no in-flight login and
        // no provider-local authenticated ref, then open a second prompt.
        if (!ownsAttempt()) throw new Error('Wallet changed')
        establishedSessionWallet = requestedWallet
        establishedSessionGeneration += 1
        return { authenticated: true, rejected: false, error: null }
      } catch (loginError) {
        attempt.active = false
        if (userRejected(loginError)) return { authenticated: false, rejected: true,
          error: 'Wallet sign-in was cancelled. Sign in when you are ready to use private features.' }
        if (loginError instanceof AuthTimeoutError) return { authenticated: false, rejected: false,
          error: 'Wallet sign-in timed out. Sign in again when your wallet is ready.' }
        return { authenticated: false, rejected: false,
          error: loginError instanceof Error ? loginError.message : 'Wallet sign-in failed; try again' }
      }
    })().finally(() => {
      if (loginInFlight.get(requestedWallet)?.promise === request) loginInFlight.delete(requestedWallet)
    })
    loginInFlight.set(requestedWallet, { generation, promise: request })
    return request
  }, [currentAttempt, ensureArcMainnet, signTypedDataAsync])

  const establishSession = useCallback(async (requestedWallet: string, explicit: boolean, generation = coordinatorGeneration) => {
    if (!await ensureArcMainnet(requestedWallet, explicit, generation)) return false
    if (establishedSessionWallet === requestedWallet) {
      initializedSession.current = { wallet: requestedWallet, result: 'authenticated' }
      authenticatedWallet.current = requestedWallet
      rejectedWallet.current = null
      setStatus('authenticated')
      setError(null)
      return true
    }
    if (authenticatedWallet.current === requestedWallet) {
      setStatus('authenticated')
      setError(null)
      return true
    }
    const checked = await initializeSession(requestedWallet, generation)
    if (!currentAttempt(requestedWallet, generation)) return false
    // A parallel consumer may have completed login while this caller awaited
    // its earlier session check. Re-adopt that result before considering a new
    // challenge; loginInFlight may already have completed and been removed.
    if (establishedSessionWallet === requestedWallet) {
      initializedSession.current = { wallet: requestedWallet, result: 'authenticated' }
      authenticatedWallet.current = requestedWallet
      rejectedWallet.current = null
      setStatus('authenticated')
      setError(null)
      return true
    }
    if (checked === 'authenticated') return true
    if (checked === 'unavailable') return false
    if (!explicit && rejectedWallet.current === requestedWallet) {
      setStatus('unauthenticated')
      return false
    }
    // Challenge creation and an existing cross-mount login are passive work.
    // Only performLogin's actual signTypedData call publishes `signing`.
    if (!loginInFlight.has(requestedWallet)) setStatus('checking')
    setError(null)
    const result = await performLogin(requestedWallet, generation)
    if (!currentAttempt(requestedWallet, generation)) return false
    if (result.authenticated) {
      initializedSession.current = { wallet: requestedWallet, result: 'authenticated' }
      authenticatedWallet.current = requestedWallet
      rejectedWallet.current = null
      setStatus('authenticated')
      setError(null)
      return true
    }
    authenticatedWallet.current = null
    initializedSession.current = { wallet: requestedWallet, result: 'unauthenticated' }
    if (result.rejected) rejectedWallet.current = requestedWallet
    setStatus(result.rejected ? 'unauthenticated' : 'error')
    setError(result.error)
    return false
  }, [currentAttempt, ensureArcMainnet, initializeSession, performLogin])
  const establishSessionRef = useRef(establishSession)
  establishSessionRef.current = establishSession

  const authenticate = useCallback(async () => {
    const active = currentWallet.current
    if (!active) return false
    rejectedWallet.current = null
    const generation = invalidateCoordinator(active)
    if (initializedSession.current?.wallet === active && initializedSession.current.result === 'unavailable') {
      initializedSession.current = null
    }
    return establishSession(active, true, generation)
  }, [establishSession])

  const request = useCallback(async (input: string, init: RequestInit = {}) => {
    if (!input.startsWith('/api/') || input.startsWith('//')) throw new Error('Invalid Mahshar request')
    const url = new URL(input, window.location.origin)
    if (url.origin !== window.location.origin) throw new Error('Invalid Mahshar request')
    const connected = getAccount(config).address
    if (!connected) throw new Error('Connect your wallet first')
    const requestedWallet = normalizedWallet(connected)
    if (!await establishSession(requestedWallet, false)) throw new Error('Sign in with your wallet to continue')
    if (getAccount(config).address?.toLowerCase() !== requestedWallet) throw new Error('Wallet changed')
    const dispatchedGeneration = establishedSessionGeneration
    const response = await fetch(input, { ...init, credentials: 'same-origin' })
    if (response.status !== 401) return response
    const rejection = await response.clone().json().catch(() => null) as { error?: unknown } | null
    if (!['Wallet session required', 'Wallet session expired'].includes(String(rejection?.error ?? ''))) return response
    // Another parallel read may already have replaced the expired session.
    // Retry with that newer cookie instead of invalidating it and prompting.
    if (establishedSessionWallet === requestedWallet && establishedSessionGeneration !== dispatchedGeneration) {
      return fetch(input, { ...init, credentials: 'same-origin' })
    }
    establishedSessionWallet = null
    authenticatedWallet.current = null
    initializedSession.current = null
    if (!await establishSession(requestedWallet, false)) return response
    if (getAccount(config).address?.toLowerCase() !== requestedWallet) throw new Error('Wallet changed')
    return fetch(input, { ...init, credentials: 'same-origin' })
  }, [config, establishSession])

  const sensitiveRequest = useCallback(async (input: string, init: RequestInit = {}) => {
    if (!input.startsWith('/api/') || input.startsWith('//')) throw new Error('Invalid Mahshar request')
    const url = new URL(input, window.location.origin)
    if (url.origin !== window.location.origin) throw new Error('Invalid Mahshar request')
    const connected = getAccount(config).address
    if (!connected) throw new Error('Connect your wallet first')
    const requestedWallet = normalizedWallet(connected)
    if (!await establishSession(requestedWallet, false)) throw new Error('Sign in with your wallet to continue')
    const generation = coordinatorGeneration
    if (!await ensureArcMainnet(requestedWallet, true, generation)) throw new Error('Switch to Arc Mainnet to continue')
    const method = (init.method ?? 'GET').toUpperCase()
    const bodyText = typeof init.body === 'string' ? init.body : null
    if (init.body != null && bodyText === null) throw new Error('Sensitive requests must use a JSON string body')
    const issuedAt = Math.floor(Date.now() / 1000)
    const deadline = issuedAt + OPERATION_AUTH_SECONDS
    const nonce = randomOperationNonce()
    const message = authorizationMessage({ wallet: requestedWallet, method, url,
      payload: requestPayload(url, method, bodyText), nonce, issuedAt, deadline })
    let signature: Hex
    try {
      signature = await serializeSignature(() => signTypedDataAsync({ account: requestedWallet,
        domain: OPERATION_AUTH_DOMAIN, types: OPERATION_AUTH_TYPES,
        primaryType: 'MahsharAuthorization', message }), () => currentAttempt(requestedWallet, generation))
    } catch (signError) {
      if (userRejected(signError)) throw new Error('Action cancelled')
      throw new Error('Wallet authorization failed; try again')
    }
    if (getAccount(config).address?.toLowerCase() !== requestedWallet || currentWallet.current !== requestedWallet) {
      throw new Error('Wallet changed; review the action and try again')
    }
    const headers = new Headers(init.headers)
    headers.set(OPERATION_AUTH_HEADER, encodeAuthorizationProof({ wallet: requestedWallet, nonce, issuedAt, deadline, signature }))
    // Never automatically replay a one-use proof. A session failure or ambiguous
    // response is surfaced so the user can review and explicitly authorize again.
    return fetch(input, { ...init, headers, credentials: 'same-origin' })
  }, [config, currentAttempt, ensureArcMainnet, establishSession, signTypedDataAsync])

  useEffect(() => {
    const priorWallet = previousWallet.current
    previousWallet.current = wallet
    const generation = coordinateWallet(wallet)
    if (!wallet || (establishedSessionWallet !== null && establishedSessionWallet !== wallet)) {
      establishedSessionWallet = null
    }
    authenticatedWallet.current = null
    initializedSession.current = null
    setError(null)
    if (!wallet) {
      if (priorWallet) automaticChainAttempts.delete(priorWallet)
      rejectedWallet.current = null
      setNetworkStatus('disconnected')
      setStatus('disconnected')
      if (priorWallet) void fetch('/api/auth/session', { method: 'DELETE', credentials: 'same-origin' }).catch(() => undefined)
      return
    }
    setNetworkStatus('checking')
    setStatus('checking')
    void establishSessionRef.current(wallet, false, generation)
  }, [wallet])

  useEffect(() => {
    if (!wallet || !connector) return
    let disposed = false
    let provider: EIP1193Provider | null = null
    const onChainChanged = (value: unknown) => {
      if (disposed || currentWallet.current !== wallet) return
      const ready = numericChainId(value) === ARC_MAINNET_CHAIN_ID
      setNetworkStatus(ready ? 'ready' : 'required')
      if (statusRef.current === 'checking' || statusRef.current === 'signing') {
        invalidateCoordinator(wallet)
        setStatus('error')
        setError(ready ? 'Wallet network changed during sign-in. Try again.' : 'Switch to Arc Mainnet and sign in again.')
      }
    }
    void connector.getProvider().then(candidate => {
      if (disposed || !candidate) return
      provider = candidate as EIP1193Provider
      provider.on?.('chainChanged', onChainChanged)
    }).catch(() => undefined)
    return () => {
      disposed = true
      provider?.removeListener?.('chainChanged', onChainChanged)
    }
  }, [connector, wallet])

  const value = useMemo(() => ({ status, networkStatus, wallet, error, request, sensitiveRequest, authenticate }),
    [authenticate, error, networkStatus, request, sensitiveRequest, status, wallet])
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useMarketplaceSession() {
  const value = useContext(SessionContext)
  if (!value) throw new Error('Marketplace session provider missing')
  return value
}
