'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { getAccount } from '@wagmi/core'
import { useAccount, useConfig, useSignTypedData } from 'wagmi'
import type { Address, Hex } from 'viem'
import { OPERATION_AUTH_DOMAIN, OPERATION_AUTH_HEADER, OPERATION_AUTH_SECONDS, OPERATION_AUTH_TYPES,
  authorizationMessage, encodeAuthorizationProof, normalizedWallet, requestPayload } from '@/lib/marketplace/operation-authorization'
import { LOGIN_AUTH_DOMAIN, LOGIN_AUTH_TYPES, loginMessage } from '@/lib/marketplace/session-auth'

type SessionStatus = 'disconnected' | 'checking' | 'signing' | 'authenticated' | 'unauthenticated' | 'error'
type SessionContextValue = {
  status: SessionStatus
  wallet: string | null
  error: string | null
  request: (input: string, init?: RequestInit) => Promise<Response>
  sensitiveRequest: (input: string, init?: RequestInit) => Promise<Response>
  authenticate: () => Promise<boolean>
}

const SessionContext = createContext<SessionContextValue | null>(null)
const loginInFlight = new Map<string, Promise<boolean>>()
const checkInFlight = new Map<string, Promise<boolean>>()
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
  const controller = useRef<AbortController | null>(null)
  const [status, setStatus] = useState<SessionStatus>(wallet ? 'checking' : 'disconnected')
  const [error, setError] = useState<string | null>(null)

  const checkSession = useCallback((requestedWallet: string) => {
    const existing = checkInFlight.get(requestedWallet)
    if (existing) return existing
    const request = fetch(`/api/auth/session?wallet=${encodeURIComponent(requestedWallet)}`, {
      credentials: 'same-origin', cache: 'no-store', signal: controller.current?.signal,
    }).then(async response => {
      if (!response.ok) return false
      const body = await response.json().catch(() => null) as { authenticated?: boolean; wallet?: string } | null
      return body?.authenticated === true && body.wallet?.toLowerCase() === requestedWallet
    }).catch(() => false).finally(() => {
      if (checkInFlight.get(requestedWallet) === request) checkInFlight.delete(requestedWallet)
    })
    checkInFlight.set(requestedWallet, request)
    return request
  }, [])

  const establishSession = useCallback((requestedWallet: string, explicit: boolean) => {
    if (authenticatedWallet.current === requestedWallet) return Promise.resolve(true)
    const existing = loginInFlight.get(requestedWallet)
    if (existing) return existing
    const request = (async () => {
      setStatus('checking')
      setError(null)
      if (await checkSession(requestedWallet)) {
        if (currentWallet.current !== requestedWallet) return false
        authenticatedWallet.current = requestedWallet
        rejectedWallet.current = null
        setStatus('authenticated')
        return true
      }
      if (!explicit && rejectedWallet.current === requestedWallet) {
        setStatus('unauthenticated')
        return false
      }
      let signed: { challenge: { challenge_id: string; wallet: string; nonce: Hex; issued_at: number;
        deadline: number; origin: string }; signature: Hex }
      try {
        signed = await serializeSignature(async () => {
          if (currentWallet.current !== requestedWallet) throw new Error('Wallet changed')
          const challengeResponse = await fetch('/api/auth/challenge', {
            method: 'POST', credentials: 'same-origin', signal: controller.current?.signal,
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
          const challenge = candidate as typeof signed.challenge
          if (currentWallet.current !== requestedWallet) throw new Error('Wallet changed')
          setStatus('signing')
          const signature = await signTypedDataAsync({ account: requestedWallet as Address, domain: LOGIN_AUTH_DOMAIN,
            types: LOGIN_AUTH_TYPES, primaryType: 'MahsharLogin', message: loginMessage({
              wallet: requestedWallet as Address, origin: challenge.origin, nonce: challenge.nonce,
              issuedAt: challenge.issued_at, deadline: challenge.deadline,
            }) })
          return { challenge, signature }
        })
      } catch (signError) {
        if (userRejected(signError)) {
          if (currentWallet.current !== requestedWallet) return false
          rejectedWallet.current = requestedWallet
          setStatus('unauthenticated')
          setError('Wallet sign-in was cancelled. Sign in when you are ready to use private features.')
          return false
        }
        throw signError instanceof Error ? signError : new Error('Wallet sign-in failed; try again')
      }
      const { challenge, signature } = signed
      if (getAccount(config).address?.toLowerCase() !== requestedWallet || currentWallet.current !== requestedWallet) {
        throw new Error('Wallet changed')
      }
      const response = await fetch('/api/auth/session', {
        method: 'POST', credentials: 'same-origin', signal: controller.current?.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          challenge_id: challenge.challenge_id, wallet: requestedWallet, nonce: challenge.nonce,
          issued_at: challenge.issued_at, deadline: challenge.deadline, signature,
        }),
      })
      const result = await response.json().catch(() => null) as { authenticated?: boolean; wallet?: string; error?: string } | null
      if (!response.ok || result?.authenticated !== true || result.wallet?.toLowerCase() !== requestedWallet) {
        throw new Error(result?.error ?? 'Wallet session could not be created')
      }
      if (currentWallet.current !== requestedWallet) return false
      authenticatedWallet.current = requestedWallet
      rejectedWallet.current = null
      setStatus('authenticated')
      setError(null)
      return true
    })().catch(loginError => {
      if (currentWallet.current === requestedWallet) {
        authenticatedWallet.current = null
        setStatus(rejectedWallet.current === requestedWallet ? 'unauthenticated' : 'error')
        setError(loginError instanceof Error ? loginError.message : 'Wallet sign-in failed')
      }
      return false
    }).finally(() => {
      if (loginInFlight.get(requestedWallet) === request) loginInFlight.delete(requestedWallet)
    })
    loginInFlight.set(requestedWallet, request)
    return request
  }, [checkSession, config, signTypedDataAsync])

  const authenticate = useCallback(async () => {
    const active = currentWallet.current
    if (!active) return false
    rejectedWallet.current = null
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
    controller.current?.abort()
    controller.current = new AbortController()
    authenticatedWallet.current = null
    setError(null)
    if (!wallet) {
      rejectedWallet.current = null
      setStatus('disconnected')
      if (priorWallet) void fetch('/api/auth/session', { method: 'DELETE', credentials: 'same-origin' }).catch(() => undefined)
      return () => controller.current?.abort()
    }
    setStatus('checking')
    void establishSession(wallet, false)
    return () => controller.current?.abort()
  }, [establishSession, wallet])

  const value = useMemo(() => ({ status, wallet, error, request, sensitiveRequest, authenticate }),
    [authenticate, error, request, sensitiveRequest, status, wallet])
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useMarketplaceSession() {
  const value = useContext(SessionContext)
  if (!value) throw new Error('Marketplace session provider missing')
  return value
}
