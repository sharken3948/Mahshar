'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { getAccount } from '@wagmi/core'
import { useAccount, useConfig, useSignTypedData } from 'wagmi'
import type { Address, Hex } from 'viem'
import { OPERATION_AUTH_DOMAIN, OPERATION_AUTH_HEADER, OPERATION_AUTH_SECONDS, OPERATION_AUTH_TYPES,
  authorizationMessage, encodeAuthorizationProof, normalizedWallet, requestPayload } from '@/lib/marketplace/operation-authorization'
import { LOGIN_AUTH_DOMAIN, LOGIN_AUTH_TYPES, loginMessage } from '@/lib/marketplace/session-auth'

type SessionStatus = 'disconnected' | 'checking' | 'signing' | 'authenticated' | 'unauthenticated' | 'error'
type SessionCheckResult = 'authenticated' | 'unauthenticated' | 'unavailable'
type LoginResult = { authenticated: boolean; rejected: boolean; error: string | null }
type SessionContextValue = {
  status: SessionStatus
  wallet: string | null
  error: string | null
  request: (input: string, init?: RequestInit) => Promise<Response>
  sensitiveRequest: (input: string, init?: RequestInit) => Promise<Response>
  authenticate: () => Promise<boolean>
}

const SessionContext = createContext<SessionContextValue | null>(null)
const loginInFlight = new Map<string, Promise<LoginResult>>()
const checkInFlight = new Map<string, Promise<SessionCheckResult>>()
let signatureQueue: Promise<void> = Promise.resolve()

function serializeSignature<T>(sign: () => Promise<T>) {
  const previous = signatureQueue
  let release!: () => void
  signatureQueue = new Promise<void>(resolve => { release = resolve })
  return previous.then(sign).finally(release)
}

function userRejected(error: unknown) {
  return !!error && typeof error === 'object' && 'code' in error && Number(error.code) === 4001
}

function randomOperationNonce(): Hex {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return `0x${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`
}

export function MarketplaceSessionProvider({ children }: { children: React.ReactNode }) {
  const { address } = useAccount()
  const config = useConfig()
  const { signTypedDataAsync } = useSignTypedData()
  const wallet = address?.toLowerCase() ?? null
  const currentWallet = useRef(wallet)
  currentWallet.current = wallet
  const previousWallet = useRef<string | null>(null)
  const authenticatedWallet = useRef<string | null>(null)
  const rejectedWallet = useRef<string | null>(null)
  const initializedSession = useRef<{ wallet: string; result: SessionCheckResult } | null>(null)
  const [status, setStatus] = useState<SessionStatus>(wallet ? 'checking' : 'disconnected')
  const [error, setError] = useState<string | null>(null)

  const checkSession = useCallback((requestedWallet: string) => {
    const existing = checkInFlight.get(requestedWallet)
    if (existing) return existing
    const request = fetch(`/api/auth/session?wallet=${encodeURIComponent(requestedWallet)}`, {
      credentials: 'same-origin', cache: 'no-store',
    }).then(async response => {
      if (response.status === 401) return 'unauthenticated' as const
      if (!response.ok) return 'unavailable' as const
      const body = await response.json().catch(() => null) as { authenticated?: boolean; wallet?: string } | null
      if (!body) return 'unavailable' as const
      return body.authenticated === true && body.wallet?.toLowerCase() === requestedWallet
        ? 'authenticated' as const : 'unauthenticated' as const
    }).catch(() => 'unavailable' as const).finally(() => {
      if (checkInFlight.get(requestedWallet) === request) checkInFlight.delete(requestedWallet)
    })
    checkInFlight.set(requestedWallet, request)
    return request
  }, [])

  const initializeSession = useCallback(async (requestedWallet: string): Promise<SessionCheckResult> => {
    if (authenticatedWallet.current === requestedWallet) return 'authenticated'
    if (initializedSession.current?.wallet === requestedWallet) return initializedSession.current.result
    if (currentWallet.current === requestedWallet) {
      setStatus('checking')
      setError(null)
    }
    const result = await checkSession(requestedWallet)
    if (currentWallet.current !== requestedWallet || getAccount(config).address?.toLowerCase() !== requestedWallet) {
      return 'unavailable'
    }
    initializedSession.current = { wallet: requestedWallet, result }
    if (result === 'authenticated') {
      authenticatedWallet.current = requestedWallet
      rejectedWallet.current = null
      setStatus('authenticated')
      setError(null)
    } else if (result === 'unavailable') {
      setStatus('error')
      setError('Wallet session could not be checked. Try again when the service is available.')
    }
    return result
  }, [checkSession, config])

  const performLogin = useCallback((requestedWallet: string): Promise<LoginResult> => {
    const existing = loginInFlight.get(requestedWallet)
    if (existing) return existing
    const request = (async (): Promise<LoginResult> => {
      try {
        if (getAccount(config).address?.toLowerCase() !== requestedWallet) throw new Error('Wallet changed')
        const challengeResponse = await fetch('/api/auth/challenge', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ wallet: requestedWallet }),
        })
        const candidate = await challengeResponse.json().catch(() => null) as {
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
          if (getAccount(config).address?.toLowerCase() !== requestedWallet) throw new Error('Wallet changed')
          return signTypedDataAsync({ account: requestedWallet as Address, domain: LOGIN_AUTH_DOMAIN,
            types: LOGIN_AUTH_TYPES, primaryType: 'MahsharLogin', message: loginMessage({
              wallet: requestedWallet as Address, origin: challenge.origin, nonce: challenge.nonce,
              issuedAt: challenge.issued_at, deadline: challenge.deadline,
            }) })
        })
        if (getAccount(config).address?.toLowerCase() !== requestedWallet) throw new Error('Wallet changed')
        const response = await fetch('/api/auth/session', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
            challenge_id: challenge.challenge_id, wallet: requestedWallet, nonce: challenge.nonce,
            issued_at: challenge.issued_at, deadline: challenge.deadline, signature,
          }),
        })
        const result = await response.json().catch(() => null) as { authenticated?: boolean; wallet?: string; error?: string } | null
        if (!response.ok || result?.authenticated !== true || result.wallet?.toLowerCase() !== requestedWallet) {
          throw new Error(result?.error ?? 'Wallet session could not be created')
        }
        return { authenticated: true, rejected: false, error: null }
      } catch (loginError) {
        if (userRejected(loginError)) return { authenticated: false, rejected: true,
          error: 'Wallet sign-in was cancelled. Sign in when you are ready to use private features.' }
        return { authenticated: false, rejected: false,
          error: loginError instanceof Error ? loginError.message : 'Wallet sign-in failed; try again' }
      }
    })().finally(() => {
      if (loginInFlight.get(requestedWallet) === request) loginInFlight.delete(requestedWallet)
    })
    loginInFlight.set(requestedWallet, request)
    return request
  }, [config, signTypedDataAsync])

  const establishSession = useCallback(async (requestedWallet: string, explicit: boolean) => {
    if (authenticatedWallet.current === requestedWallet) return true
    const checked = await initializeSession(requestedWallet)
    if (currentWallet.current !== requestedWallet || getAccount(config).address?.toLowerCase() !== requestedWallet) return false
    if (checked === 'authenticated') return true
    if (checked === 'unavailable') return false
    if (!explicit && rejectedWallet.current === requestedWallet) {
      setStatus('unauthenticated')
      return false
    }
    setStatus('signing')
    setError(null)
    const result = await performLogin(requestedWallet)
    if (currentWallet.current !== requestedWallet || getAccount(config).address?.toLowerCase() !== requestedWallet) return false
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
  }, [config, initializeSession, performLogin])
  const establishSessionRef = useRef(establishSession)
  establishSessionRef.current = establishSession

  const authenticate = useCallback(async () => {
    const active = currentWallet.current
    if (!active) return false
    rejectedWallet.current = null
    if (initializedSession.current?.wallet === active && initializedSession.current.result === 'unavailable') {
      initializedSession.current = null
    }
    return establishSession(active, true)
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
    const response = await fetch(input, { ...init, credentials: 'same-origin' })
    if (response.status !== 401) return response
    const rejection = await response.clone().json().catch(() => null) as { error?: unknown } | null
    if (!['Wallet session required', 'Wallet session expired'].includes(String(rejection?.error ?? ''))) return response
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
        primaryType: 'MahsharAuthorization', message }))
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
  }, [config, establishSession, signTypedDataAsync])

  useEffect(() => {
    const priorWallet = previousWallet.current
    previousWallet.current = wallet
    authenticatedWallet.current = null
    initializedSession.current = null
    setError(null)
    if (!wallet) {
      rejectedWallet.current = null
      setStatus('disconnected')
      if (priorWallet) void fetch('/api/auth/session', { method: 'DELETE', credentials: 'same-origin' }).catch(() => undefined)
      return
    }
    setStatus('checking')
    void establishSessionRef.current(wallet, false)
  }, [wallet])

  const value = useMemo(() => ({ status, wallet, error, request, sensitiveRequest, authenticate }),
    [authenticate, error, request, sensitiveRequest, status, wallet])
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useMarketplaceSession() {
  const value = useContext(SessionContext)
  if (!value) throw new Error('Marketplace session provider missing')
  return value
}
