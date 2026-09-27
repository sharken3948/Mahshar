'use client'
import { useCallback } from 'react'
import { getAccount } from '@wagmi/core'
import { useConfig, useSignTypedData } from 'wagmi'
import { OPERATION_AUTH_DOMAIN, OPERATION_AUTH_HEADER, OPERATION_AUTH_SECONDS, OPERATION_AUTH_TYPES,
  authorizationMessage, encodeAuthorizationProof, normalizedWallet, requestPayload } from '@/lib/marketplace/operation-authorization'
import type { Hex } from 'viem'

function randomNonce(): Hex {
  const bytes = new Uint8Array(32); crypto.getRandomValues(bytes)
  return `0x${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`
}
export function useWalletAuthorization() {
  const config = useConfig(); const { signTypedDataAsync } = useSignTypedData()
  const request = useCallback(async (input: string, init: RequestInit = {}) => {
    if (!input.startsWith('/api/') || input.startsWith('//')) throw new Error('Invalid Mahshar request')
    const connectedAddress = getAccount(config).address
    if (!connectedAddress) throw new Error('Connect your wallet first')
    const wallet = normalizedWallet(connectedAddress); const url = new URL(input, window.location.origin)
    if (url.origin !== window.location.origin) throw new Error('Invalid Mahshar request')
    const method = (init.method ?? 'GET').toUpperCase(); const bodyText = typeof init.body === 'string' ? init.body : null
    if (init.body != null && bodyText === null) throw new Error('Authorized requests must use a JSON string body')
    const issuedAt = Math.floor(Date.now() / 1000); const deadline = issuedAt + OPERATION_AUTH_SECONDS; const nonce = randomNonce()
    const message = authorizationMessage({ wallet, method, url, payload: requestPayload(url, method, bodyText), nonce, issuedAt, deadline })
    let signature: Hex
    try {
      signature = await signTypedDataAsync({ account: wallet, domain: OPERATION_AUTH_DOMAIN, types: OPERATION_AUTH_TYPES,
        primaryType: 'MahsharAuthorization', message })
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? Number(error.code) : null
      if (code === 4001) throw new Error('Action cancelled')
      throw new Error('Wallet authorization failed; try again')
    }
    if (getAccount(config).address?.toLowerCase() !== wallet) throw new Error('Wallet changed; review the action and try again')
    const headers = new Headers(init.headers); headers.set(OPERATION_AUTH_HEADER, encodeAuthorizationProof({ wallet, nonce, issuedAt, deadline, signature }))
    return fetch(input, { ...init, headers, credentials: 'same-origin' })
  }, [config, signTypedDataAsync])
  return { request }
}
