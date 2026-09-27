'use client'
import { useEffect, useRef, useState } from 'react'
import { useAccount, usePublicClient, useSwitchChain } from 'wagmi'
import { AppKit, UnifiedBalanceChain } from '@circle-fin/app-kit'
import { Arc, type BridgeResult } from '@circle-fin/bridge-kit'
import { createViemAdapterFromProvider } from '@circle-fin/adapter-viem-v2'
import { erc20Abi, formatUnits, parseUnits, type EIP1193Provider } from 'viem'
import type { useBridge } from '@/hooks/useBridge'
import { validateBridgeResult } from '@/lib/circle-bridge'
import { bridgeErrorMessage, resumableResult } from '@/lib/bridge-journey-state'
import { BRIDGE_ACTIVITY_PREFIX } from '@/lib/product-preferences'
import type { WalletRefreshAction } from '@/lib/wallet-refresh'

export interface Activity {
  id: string; date: string; source: string; amount: string
  result?: BridgeResult
  deposit: 'pending' | 'available' | 'unavailable' | 'current' | 'completed' | 'failed'
  depositHash?: string; receivedAmount?: string; depositedAmount?: string; error?: string
}
const appKit = new AppKit()

// Local activity is display-only. It never authorizes a deposit or a replay.
export function useBridgeJourney(bridge: ReturnType<typeof useBridge>, scheduleRefresh: (action: WalletRefreshAction) => void) {
  const { address, connector: evmConnector } = useAccount()
  const { switchChainAsync: switchEvmChainAsync } = useSwitchChain()
  const client = usePublicClient({ chainId: Arc.chainId })
  const owner = useRef(address); owner.current = address
  const busy = useRef(false)
  const [active, setActive] = useState<Activity | null>(null)
  const [activity, setActivity] = useState<Activity[]>([])
  const [bridging, setBridging] = useState(false)
  const [depositing, setDepositing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [storageError, setStorageError] = useState<string | null>(null)
  useEffect(() => {
    owner.current = address; busy.current = false; setBridging(false); setDepositing(false)
    return () => { owner.current = undefined }
  }, [address])
  useEffect(() => {
    setActive(null); setActivity([]); setError(null); setStorageError(null)
    if (!address) return
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(BRIDGE_ACTIVITY_PREFIX + address.toLowerCase()) ?? '[]')
      if (!Array.isArray(saved)) throw Error('Invalid activity')
      const rows = saved.slice(0,100).filter((item): item is Activity => {
        if (!item || typeof item !== 'object' || typeof item.id !== 'string' || typeof item.source !== 'string' || typeof item.amount !== 'string' || !Number.isFinite(Date.parse(item.date)) || !['pending','available','unavailable','current','completed','failed'].includes(item.deposit)) return false
        try { if (item.result) validateBridgeResult(item.result,address); return true } catch { return false }
      })
      setActivity(rows)
    } catch { setStorageError('Saved activity is unavailable on this device.') }
  }, [address])

  useEffect(() => {
    if (!address || !bridge.result) return
    const result = bridge.result
    if (result.state === 'error' && !resumableResult(result)) {
      try {
        const rows: Activity[] = JSON.parse(localStorage.getItem(BRIDGE_ACTIVITY_PREFIX + address.toLowerCase()) ?? '[]')
        const signature = JSON.stringify(result)
        if (!rows.some(row => row.result && JSON.stringify(row.result) === signature)) {
          save({ id: crypto.randomUUID(), date: new Date().toISOString(), source: result.source.chain.chain,
            amount: result.amount, result, deposit: 'unavailable',
            error: bridgeErrorMessage(result.steps.find(step => step.state === 'error')?.errorMessage ?? 'Circle reported a failed transfer.') }, address)
        }
      } catch { /* Display-only history must not interfere with SDK recovery. */ }
      return
    }
    const burn = result.steps.find(step => step.name === 'burn')?.txHash
    if (!burn) return
    try {
      const rows: Activity[] = JSON.parse(localStorage.getItem(BRIDGE_ACTIVITY_PREFIX + address.toLowerCase()) ?? '[]')
      const record = rows.find(row => row.result?.steps.some(step => step.name === 'burn' && step.txHash === burn))
      if (record) save({ ...record, result }, address)
    } catch { /* Display-only history must not interfere with SDK recovery. */ }
  }, [address, bridge.result])

  function save(record: Activity, wallet: string) {
    const key = BRIDGE_ACTIVITY_PREFIX + wallet.toLowerCase()
    let next: Activity[] = [record]
    try {
      const previous: Activity[] = JSON.parse(localStorage.getItem(key) ?? '[]')
      next = [record, ...(Array.isArray(previous) ? previous.filter(item => item.id !== record.id) : [])].slice(0,100)
      localStorage.setItem(key, JSON.stringify(next, (_,value) => typeof value === 'bigint' ? value.toString() : value))
    } catch { if (owner.current === wallet) setStorageError('Activity could not be saved on this device. Keep the transaction links.') }
    if (owner.current === wallet) { setActive(record); setActivity(next) }
  }

  async function start(source: string, amount: string) {
    if (busy.current || bridge.pending || bridge.isLoading || !address || !client) return
    const wallet = address
    const assertOwner = () => { if (owner.current !== wallet) throw Error('Wallet changed. Review the completed transfer in the original Arc wallet.') }
    busy.current = true; setBridging(true); setError(null)
    let record: Activity = { id: crypto.randomUUID(), date: new Date().toISOString(), source, amount, deposit: 'pending' }
    try {
      // A fresh baseline lets the optional deposit use only this bridge's net receipt.
      // The bridge may still complete if this read later cannot be reconciled.
      let before: bigint | undefined
      try { before = await client.readContract({ address: Arc.usdcAddress, abi: erc20Abi, functionName: 'balanceOf', args: [wallet] }) } catch { before = undefined }
      assertOwner()
      save(record,wallet)
      const result = await bridge.bridge(source, amount)
      if (!result) {
        const failure = bridge.lastFailure?.()
        record = { ...record, deposit: failure?.terminal ? 'unavailable' : 'pending', error: failure?.message ?? 'Transfer needs review. Check Bridge Progress before continuing.' }
        save(record,wallet); return
      }
      record = { ...record, result, deposit: result.state === 'error' && !resumableResult(result) ? 'unavailable' : 'pending' }; save(record,wallet)
      if (result.state !== 'success') return
      validateBridgeResult(result,wallet)
      assertOwner()
      scheduleRefresh({ kind: 'bridge', source: result.source.chain.type === 'solana' ? 'solana' : 'evm' })
      if (before === undefined) throw Error('The Arc balance baseline was unavailable. The bridge is complete; review the Arc wallet before depositing.')
      const after = await client.readContract({ address: Arc.usdcAddress, abi: erc20Abi, functionName: 'balanceOf', args: [wallet] })
      const received = after - before
      if (received <= BigInt(0) || received > parseUnits(result.amount,6)) throw Error('Received Arc balance could not be isolated. The bridge is complete; review the Arc wallet before depositing.')
      const actualAmount = formatUnits(received,6)
      record = { ...record, deposit: 'available', receivedAmount: actualAmount }; save(record,wallet)
    } catch (err) {
      const message = bridgeErrorMessage(err)
      record = { ...record, deposit: record.result?.state === 'success' ? 'unavailable' : record.deposit, error: message }; save(record,wallet)
      if (owner.current === wallet) setError(message)
    } finally { busy.current = false; if (owner.current === wallet) setBridging(false) }
  }

  async function deposit() {
    if (busy.current || !address || !client || !evmConnector || !active || active.result?.state !== 'success' || active.deposit !== 'available' || !active.receivedAmount) return
    const wallet = address
    const receivedAmount = active.receivedAmount
    const assertOwner = () => { if (owner.current !== wallet) throw Error('Reconnect the Arc recipient wallet before depositing.') }
    let record = active
    busy.current = true; setDepositing(true); setError(null)
    try {
      validateBridgeResult(record.result!,wallet)
      const amount = parseUnits(receivedAmount,6)
      if (amount <= BigInt(0) || amount > parseUnits(record.result!.amount,6)) throw Error('The measured Arc receipt is invalid. Review and deposit from Wallet.')
      await switchEvmChainAsync({ chainId: Arc.chainId })
      assertOwner()
      // The bridge source may be Solana, but the receipt and optional deposit are on Arc.
      // Only the connected Wagmi EVM connector may authorize this Gateway deposit.
      const provider = await evmConnector.getProvider() as EIP1193Provider
      const accounts = await provider.request({ method: 'eth_accounts' })
      if (accounts[0]?.toLowerCase() !== wallet.toLowerCase()) throw Error('Reconnect the original Arc recipient before depositing.')
      const remaining = await client.readContract({ address: Arc.usdcAddress, abi: erc20Abi, functionName: 'balanceOf', args: [wallet] })
      if (remaining < amount) throw Error('Arc balance changed. Review and deposit from Wallet.')
      const adapter = await createViemAdapterFromProvider({ provider })
      assertOwner()
      record = { ...record, deposit: 'current', depositedAmount: receivedAmount, error: undefined }; save(record,wallet)
      // This official Gateway deposit is only reached from the explicit UI action.
      const deposited = await appKit.unifiedBalance.deposit({ from: { adapter, chain: UnifiedBalanceChain.Arc }, amount: receivedAmount, token: 'USDC', allowanceStrategy: 'approve' })
      record = { ...record, depositHash: deposited.txHash }; save(record,wallet)
      const receipt = await client.waitForTransactionReceipt({ hash: deposited.txHash as `0x${string}` })
      if (receipt.status !== 'success') throw Error('Gateway deposit transaction reverted. Review the transaction in Wallet.')
      record = { ...record, deposit: 'completed' }; save(record,wallet)
      if (owner.current === wallet) scheduleRefresh({ kind: 'gatewayDeposit' })
    } catch (err) {
      const message = bridgeErrorMessage(err)
      record = { ...record, deposit: 'failed', error: message }; save(record,wallet)
      if (owner.current === wallet) setError(message)
    } finally { busy.current = false; if (owner.current === wallet) setDepositing(false) }
  }
  return { start, deposit, active, activity, bridging, depositing, working: bridging || depositing, error, storageError }
}
