'use client'
import { useState, useCallback } from 'react'
import { useAccount, useSwitchChain } from 'wagmi'
import { BridgeKit, BridgeChain } from '@circle-fin/bridge-kit'
import { AppKit, UnifiedBalanceChain } from '@circle-fin/app-kit'
import { createViemAdapterFromProvider } from '@circle-fin/adapter-viem-v2'
import type { EIP1193Provider } from 'viem'

export type BridgeStepName =
  | 'idle' | 'switching' | 'approving' | 'burning' | 'attesting' | 'minting'
  | 'waiting' | 'depositing' | 'complete' | 'error'

export const BRIDGE_STEP_LABELS: Record<BridgeStepName, string> = {
  idle: 'Bridge to Arc',
  switching: 'Switching network...',
  approving: 'Approving USDC...',
  burning: 'Burning USDC...',
  attesting: 'Waiting for attestation...',
  minting: 'Minting on Arc...',
  waiting: 'Waiting for Arc...',
  depositing: 'Depositing to Gateway...',
  complete: 'Complete!',
  error: 'Try again',
}

const bridgeKit = new BridgeKit()
const appKit = new AppKit()

export function useBridge() {
  const { connector } = useAccount()
  const { switchChainAsync } = useSwitchChain()
  const [step, setStep] = useState<BridgeStepName>('idle')
  const [error, setError] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<string | null>(null)

  const bridge = useCallback(async (
    fromChain: BridgeChain,
    fromChainId: number,
    amount: string,
    recipientAddress: `0x${string}`,
  ) => {
    if (!connector) return
    setStep('switching')
    setError(null)
    setTxHash(null)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handleEvent = (payload: any) => {
      switch (payload?.method) {
        case 'approve':          setStep('burning');    break
        case 'burn':             setStep('attesting');  break
        case 'fetchAttestation': setStep('minting');    break
        case 'mint':
          if (payload?.values?.txHash) setTxHash(payload.values.txHash as string)
          break
      }
    }

    try {
      // Switch to source chain BEFORE creating the adapter — required for browser wallets
      await switchChainAsync({ chainId: fromChainId })

      const provider = (await connector.getProvider()) as EIP1193Provider
      const adapter = await createViemAdapterFromProvider({ provider })

      bridgeKit.on('*', handleEvent)
      setStep('approving')

      try {
        const result = await bridgeKit.bridge({
          from: { adapter, chain: fromChain },
          to: {
            recipientAddress,
            chain: BridgeChain.Arc_Testnet,
            useForwarder: true,
          },
          amount,
        })

        if (result.state !== 'success') {
          const failed = result.steps?.find((s: { state: string }) => s.state === 'error') as { errorMessage?: string } | undefined
          setError(failed?.errorMessage ?? 'Bridge failed')
          setStep('error')
          return
        }
      } finally {
        bridgeKit.off('*', handleEvent)
      }

      // Step 2: deposit bridged USDC into Gateway on Arc Testnet
      setStep('waiting')
      await switchChainAsync({ chainId: 5042002 })
      await new Promise(resolve => setTimeout(resolve, 3000))

      setStep('depositing')
      const arcProvider = (await connector.getProvider()) as EIP1193Provider
      const arcAdapter = await createViemAdapterFromProvider({ provider: arcProvider })

      const depositResult = await appKit.unifiedBalance.deposit({
        from: { adapter: arcAdapter, chain: UnifiedBalanceChain.Arc_Testnet },
        amount,
        token: 'USDC',
      })

      if (depositResult.txHash) setTxHash(depositResult.txHash)
      setStep('complete')
    } catch (err: unknown) {
      bridgeKit.off('*', handleEvent)
      setError(err instanceof Error ? err.message : String(err))
      setStep('error')
    }
  }, [connector, switchChainAsync])

  const reset = useCallback(() => {
    setStep('idle')
    setError(null)
    setTxHash(null)
  }, [])

  return {
    bridge,
    step,
    stepLabel: BRIDGE_STEP_LABELS[step],
    isLoading: step !== 'idle' && step !== 'complete' && step !== 'error',
    error,
    txHash,
    reset,
  }
}
