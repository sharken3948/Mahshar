'use client'
import { useEffect, useRef, useState } from 'react'
import { useAccount, useSwitchChain } from 'wagmi'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import type { Transaction, VersionedTransaction } from '@solana/web3.js'
import { Arc, BridgeKit, BridgeChain, Solana, type BridgeResult } from '@circle-fin/bridge-kit'
type BridgeStep = BridgeResult['steps'][number]
import { createViemAdapterFromProvider } from '@circle-fin/adapter-viem-v2'
import { createSolanaAdapterFromProvider } from '@circle-fin/adapter-solana'
import type { EIP1193Provider } from 'viem'
import { bridgeSource, discoverCircleRoutes, type CircleRoutes, validateBridgeResult, usdcAmount } from '@/lib/circle-bridge'
import { bridgeErrorMessage, circleFeeIssue, preBroadcastFailure, resumableResult } from '@/lib/bridge-journey-state'

// UI state and SDK recovery data only. Circle owns all CCTP execution.
const STORAGE = 'mahshar:circle-bridge:v1:'
export function useBridge() {
  const { address, connector } = useAccount()
  const { switchChainAsync } = useSwitchChain()
  const solana = useWallet()
  const { connection } = useConnection()
  const [catalog, setCatalog] = useState<CircleRoutes | null>(null)
  useEffect(() => { let active = true; void discoverCircleRoutes().then(value => { if (active) setCatalog(value) }); return () => { active = false } }, [])
  const busy = useRef(false)
  const currentAddress = useRef(address)
  currentAddress.current = address
  const [isLoading, setLoading] = useState(false)
  const [result, setResult] = useState<BridgeResult | null>(null)
  const [pending, setPending] = useState(false)
  const [resumable, setResumable] = useState(false)
  const lastFailure = useRef<{ terminal: boolean; message: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [technicalError, setTechnicalError] = useState<string | null>(null)
  const [recoveryNotice, setRecoveryNotice] = useState<string | null>(null)
  const [stepLabel, setStepLabel] = useState('Ready to bridge')
  const [liveSteps, setLiveSteps] = useState<BridgeStep[]>([])
  const burnEvidence = useRef(false)
  const key = address ? STORAGE + address.toLowerCase() : null

  useEffect(() => {
    setResult(null); setPending(false); setResumable(false); setError(null); setTechnicalError(null); setRecoveryNotice(null); setLiveSteps([]); setStepLabel('Ready to bridge')
    if (!key || !address) return
    try {
      const saved = localStorage.getItem(key)
      if (!saved) return
      const parsed = JSON.parse(saved)
      if (parsed.result) {
        validateBridgeResult(parsed.result, address)
        setResult(parsed.result)
        const canResume = resumableResult(parsed.result)
        setPending(canResume)
        setResumable(canResume)
        setStepLabel(parsed.result.state === 'success' ? 'USDC confirmed in Arc wallet' : canResume ? 'Resume existing transfer' : 'Bridge failed before submission')
        if (parsed.result.state === 'error') {
          const detail = parsed.result.steps.find((step: BridgeStep) => step.state === 'error')?.errorMessage ?? 'Circle reported a failed transfer.'
          setError(bridgeErrorMessage(detail)); setTechnicalError(detail)
        }
      } else if (parsed.failure?.terminal === true) {
        setStepLabel('Bridge failed before submission')
        setError(bridgeErrorMessage(parsed.failure.message))
        setTechnicalError(parsed.failure.message)
      } else {
        setPending(true)
        setStepLabel('Saved submission needs review')
        setRecoveryNotice('A prior submission has no SDK result. Check your source wallet transaction before starting another transfer.')
      }
    } catch { setPending(true); setStepLabel('Saved transfer needs review'); setRecoveryNotice('Saved transfer needs review. Do not submit another burn.') }
  }, [key, address])

  async function sourceAdapter(source: string, expectedAccount?: string, readOnly = false) {
    const chain = source === BridgeChain.Arc && readOnly ? Arc : bridgeSource(source)
    if (chain.type === 'solana') {
      const owner = solana.publicKey?.toBase58()
      if (!owner || !solana.signTransaction) throw new Error('Connect a Solana wallet that can sign transactions.')
      if (expectedAccount && owner !== expectedAccount) throw new Error('Reconnect the original Solana wallet.')
      if (await connection.getGenesisHash() !== '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d') throw new Error('Solana Mainnet RPC required.')
      return createSolanaAdapterFromProvider({ connection, capabilities: { supportedChains: [Solana] }, provider: {
        isConnected: true, publicKey: solana.publicKey!,
        connect: async () => { throw new Error('Connect your Solana wallet before bridging.') },
        disconnect: readOnly ? async () => { throw new Error('Estimate cannot disconnect a wallet.') } : solana.disconnect,
        signTransaction: tx => { if (readOnly) throw new Error('Estimate cannot sign.'); return solana.signTransaction!(tx as Transaction | VersionedTransaction) },
        signAllTransactions: solana.signAllTransactions
          ? txs => { if (readOnly) throw new Error('Estimate cannot sign.'); return solana.signAllTransactions!(txs as (Transaction | VersionedTransaction)[]) } : undefined,
      } })
    }
    if (!connector || !address) throw new Error('Connect your EVM wallet.')
    if (expectedAccount && expectedAccount.toLowerCase() !== address.toLowerCase()) throw new Error('Reconnect the original source wallet.')
    if (chain.type !== 'evm') throw new Error('Unsupported wallet ecosystem')
    const chainId = chain.chainId
    if (!readOnly) await switchChainAsync({ chainId })
    const provider = await connector.getProvider() as EIP1193Provider
    const accounts = await provider.request({ method: 'eth_accounts' })
    if (accounts[0]?.toLowerCase() !== address.toLowerCase()) throw new Error('Wallet account changed. Review the recipient again.')
    // Estimation never requests accounts, switches chains, signs or submits.
    const estimateProvider = { request: async (args: { method: string; params?: unknown }) => {
      if (!['eth_accounts', 'eth_chainId', 'eth_call', 'eth_estimateGas', 'eth_gasPrice', 'eth_getBalance', 'eth_getCode', 'eth_getBlockByNumber', 'eth_feeHistory', 'eth_maxPriorityFeePerGas'].includes(args.method)) throw new Error('Wallet operation unavailable during estimation.')
      return provider.request(args as Parameters<EIP1193Provider['request']>[0])
    } } as EIP1193Provider
    return createViemAdapterFromProvider({ provider: readOnly ? estimateProvider : provider })
  }

  async function estimate(source: string, amount: string) {
    if (!address || busy.current) throw new Error('Connect your wallet and wait for the current transfer.')
    const owner = address
    const kit = new BridgeKit()
    const route = (await discoverCircleRoutes(kit)).routes.find(item => item.source.chain === source)
    if (!route) throw new Error('Circle does not confirm this route.')
    const adapter = await sourceAdapter(source, undefined, true)
    const destinationAdapter = route.useForwarder ? undefined : await sourceAdapter(BridgeChain.Arc, undefined, true)
    if (currentAddress.current !== owner) throw new Error('Wallet changed; request a new estimate.')
    const value = await kit.estimate({ from: { adapter, chain: route.source },
      to: destinationAdapter ? { adapter: destinationAdapter, chain: BridgeChain.Arc, recipientAddress: owner, useForwarder: false } : { chain: BridgeChain.Arc, recipientAddress: owner, useForwarder: true },
      amount: usdcAmount(amount), token: 'USDC' })
    const feeIssue = circleFeeIssue(amount, value)
    if (feeIssue) throw new Error(feeIssue)
    return value
  }

  async function run(source: string, amount: string, resume: boolean) {
    if (busy.current || !address || !key) return
    busy.current = true; burnEvidence.current = false; setLoading(true); setError(null); setTechnicalError(null); setRecoveryNotice(null); setLiveSteps([]); lastFailure.current = null
    const kit = new BridgeKit()
    let submissionStarted = false
    let existingTransfer = false
    try {
      const route = (await discoverCircleRoutes(kit)).routes.find(route => route.source.chain === source)
      if (!route) throw new Error('Circle does not currently confirm this Mainnet USDC route to Arc.')
      const chain = route.source.chain
      const normalized = usdcAmount(amount)
      if (!resume) {
        const saved = localStorage.getItem(key)
        if (saved) {
          const previous = JSON.parse(saved)
          if (previous.result) {
            validateBridgeResult(previous.result, address)
            if (resumableResult(previous.result)) { existingTransfer = true; throw new Error('Review or resume the existing transfer first.') }
          } else if (previous.failure?.terminal !== true) { existingTransfer = true; throw new Error('Review the existing submission before starting another transfer.') }
        }
      }
      if (resume) {
        if (!result || !resumableResult(result)) throw new Error('No recoverable SDK transfer to resume.')
        validateBridgeResult(result, address)
      }
      setStepLabel('Preparing source wallet')
      if (!resume) {
        const quoteAdapter = await sourceAdapter(source, undefined, true)
        const quoteDestination = route.useForwarder ? undefined : await sourceAdapter(BridgeChain.Arc, undefined, true)
        const quote = await kit.estimate({ from: { adapter: quoteAdapter, chain: route.source },
          to: quoteDestination ? { adapter: quoteDestination, chain: BridgeChain.Arc, recipientAddress: address, useForwarder: false } : { chain: BridgeChain.Arc, recipientAddress: address, useForwarder: true },
          amount: normalized, token: 'USDC' })
        const feeIssue = circleFeeIssue(normalized, quote)
        if (feeIssue) throw new Error(feeIssue)
      }
      const adapter = await sourceAdapter(source, resume ? result!.source.address : undefined)
      if (currentAddress.current !== address) throw new Error('Wallet changed. Review the destination before bridging.')
      // The official browser adapter switches networks for destination mint signing.
      // Solana sources use the connected EVM wallet as the separate Arc adapter.
      const forwarded = resume ? result!.destination.useForwarder === true : route.useForwarder
      if (forwarded && !route.useForwarder) throw new Error('Circle no longer confirms forwarding for this saved route.')
      if (!forwarded && !connector) throw new Error('Connect your EVM wallet for the Arc mint.')
      const evmProvider = !forwarded ? await connector!.getProvider() as EIP1193Provider : undefined
      if (evmProvider) {
        const accounts = await evmProvider.request({ method: 'eth_accounts' })
        if (accounts[0]?.toLowerCase() !== address.toLowerCase()) throw new Error('Reconnect the Arc recipient wallet.')
      }
      const destinationAdapter = evmProvider ? await createViemAdapterFromProvider({ provider: evmProvider }) : undefined
      // Persist before SDK execution: an unknown submission must never auto-reburn.
      if (!resume) localStorage.setItem(key, JSON.stringify({ source: chain, amount: normalized }))
      submissionStarted = true
      setPending(true)
      setResumable(false)
      if (!resume) setResult(null)
      setStepLabel(resume ? 'Resuming Circle transfer' : 'Confirm the USDC transfer in your wallet')
      kit.on('burn', event => { if (currentAddress.current === address && 'state' in event.values && event.values.state === 'success') setStepLabel(forwarded ? 'Waiting for Circle attestation and forwarding' : 'Waiting for Circle attestation, then confirm the Arc mint') })
      for (const name of ['approve', 'burn', 'fetchAttestation', 'mint'] as const) kit.on(name, event => {
        if (currentAddress.current !== address) return
        if (!('state' in event.values)) return
        const step: BridgeStep = { ...event.values, name }
        if (name === 'burn' && (step.txHash || step.state === 'success')) burnEvidence.current = true
        setLiveSteps(previous => [...previous.filter(item => item.name !== name), step])
      })
      const to = destinationAdapter
        ? { chain: BridgeChain.Arc, recipientAddress: address, adapter: destinationAdapter, useForwarder: false as const }
        : { chain: BridgeChain.Arc, recipientAddress: address, useForwarder: true as const }
      const next = resume
        ? await kit.retry(result!, { from: adapter, ...(destinationAdapter ? { to: destinationAdapter } : {}) })
        : await kit.bridge({ from: { adapter, chain: route.source }, to, amount: normalized, token: 'USDC' })
      validateBridgeResult(next, address)
      localStorage.setItem(key, JSON.stringify({ result: next }, (_, value) => typeof value === 'bigint' ? value.toString() : value))
      if (currentAddress.current !== address) return
      setResult(next)
      const canResume = resumableResult(next)
      setPending(canResume); setResumable(canResume)
      setStepLabel(next.state === 'success' ? 'USDC confirmed in Arc wallet' : next.state === 'pending' ? 'Circle transfer in progress' : canResume ? 'Transfer needs attention' : 'Bridge failed before submission')
      if (next.state === 'error' || next.steps.some(step => step.state === 'error')) {
        const detail = next.steps.find(step => step.state === 'error')?.errorMessage ?? 'Circle reported a failed transfer.'
        setError(bridgeErrorMessage(detail)); setTechnicalError(detail)
        lastFailure.current = { terminal: !canResume, message: bridgeErrorMessage(detail) }
      }
      return next
    } catch (err) {
      if (currentAddress.current !== address) return
      const detail = err instanceof Error ? err.message : String(err)
      const message = bridgeErrorMessage(detail)
      if (existingTransfer) { setError(message); return }
      const terminal = !submissionStarted || (preBroadcastFailure(err) && !burnEvidence.current)
      lastFailure.current = { terminal, message }
      setError(message); setTechnicalError(detail)
      setPending(!terminal); setResumable(false)
      setStepLabel(terminal ? 'Bridge failed before submission' : 'Transfer needs attention')
      if (terminal && !resume) localStorage.setItem(key, JSON.stringify({ source, amount, failure: { terminal: true, message: detail } }))
    } finally { busy.current = false; setLoading(false) }
  }

  function reset() {
    if (busy.current || !key || pending) return
    localStorage.removeItem(key); setPending(false); setResumable(false); setResult(null); setError(null); setTechnicalError(null); setRecoveryNotice(null); setLiveSteps([]); setStepLabel('Ready to bridge')
  }
  return {
    bridge: (source: string, amount: string) => run(source, amount, false),
    retry: () => result ? run(result.source.chain.chain, result.amount, true) : Promise.resolve(),
    reset, result, pending, resumable, isLoading, error, technicalError, recoveryNotice, stepLabel, catalog, estimate, liveSteps,
    lastFailure: () => lastFailure.current,
    adapterReady: (source: string) => Boolean(address && connector && (source !== BridgeChain.Solana || (solana.publicKey && solana.signTransaction))),
  }
}
