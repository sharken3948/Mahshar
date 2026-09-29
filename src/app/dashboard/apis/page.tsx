'use client'

import { ConnectButton } from '@rainbow-me/rainbowkit'
import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { buildViewCodeSnippet, renderHighlightedSnippet } from '@/lib/snippets'
import { DashboardCardHeader, DashboardIcon } from '../dashboard-visuals'
import { useDashboardWorkspace } from '../dashboard-workspace'
import { EditListingForm } from '@/components/EditListingForm'
import { useProductPreferences } from '@/components/ProductPreferencesProvider'
import { paidCallCount } from '@/lib/marketplace/seller-statistics'
import styles from '../dashboard.module.css'

const inputCls = 'w-full rounded-lg border border-[#2775CA] bg-[#FAFAF8] px-3 py-2.5 text-sm text-[#0D0D0D] placeholder-[#6B7280] focus:border-[#2775CA] focus:outline-none focus:ring-1 focus:ring-[#2775CA] transition-colors'

function successTone(rate: number) {
  return rate === 100 ? 'bg-[#F0FDF4] text-[#16A34A]' : rate >= 50 ? 'bg-[#FFF7ED] text-[#D97706]' : 'bg-[#FEF2F2] text-[#DC2626]'
}

export default function ApisDashboardPage() {
  const { formatUsdc } = useProductPreferences()
  const {
    isConnected,
    myApis,
    sellerEarnings,
    loading,
    sellCallGroups,
    callGroups,
    detailsApi,
    setDetailsApi,
    detailsSellApi,
    setDetailsSellApi,
    editingApi,
    setEditingApi,
    showEditModal,
    setShowEditModal,
    deletingApiId,
    setDeletingApiId,
    deleteConfirmText,
    setDeleteConfirmText,
    apiActionError,
    setApiActionError,
    viewApiModal,
    setViewApiModal,
    viewApiResponse,
    viewApiLoading,
    viewApiCopied,
    setViewApiCopied,
    updateEditedListing,
    handleDeleteConfirm,
    toggleActive,
    handleViewApi,
    beginEditApi,
  } = useDashboardWorkspace()

  if (!isConnected) {
    return (
      <div className="flex min-h-[70vh] flex-col items-center justify-center gap-6">
        <div className="rounded-2xl bg-blue-50 p-5 text-[#2775CA]"><DashboardIcon name="apis" /></div>
        <h1 className="text-2xl font-bold text-[#0D0D0D]">Connect Your Wallet</h1>
        <p className="max-w-sm text-center text-sm leading-relaxed text-slate-500">Connect to manage your Mahshar API listings and activity.</p>
        <ConnectButton />
      </div>
    )
  }

  if (showEditModal && editingApi) {
    return <div className={styles.content}><EditListingForm listing={editingApi}
      onClose={() => { setShowEditModal(false); setEditingApi(null) }} onListingChange={updateEditedListing} /></div>
  }

  const totalCalls = paidCallCount(sellerEarnings)
  const activeApis = myApis.filter(api => api.is_active).length
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://mahshar.xyz'
  const viewCodeSnippet = viewApiModal ? buildViewCodeSnippet(viewApiModal.apiId, appUrl, viewApiModal.method) : ''

  return (
    <div className={styles.content}>
      <div className={styles.pageHeader}>
        <p className={styles.eyebrow}>YOUR API BUSINESS</p>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1>APIs</h1>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[#6B7280]">Manage the services you list, review their activity, and keep control of their availability.</p>
          </div>
          <Link href="/seller" className={styles.listLink}>+ List New API</Link>
        </div>
      </div>

      <div className="mb-10 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Total APIs" value={String(myApis.length)} detail="listed services" tone="blue" icon="apis" />
        <Metric label="Active APIs" value={String(activeApis)} detail="available to buyers" tone="green" icon="dashboard" />
        <Metric label="Total Calls" value={sellerEarnings ? String(totalCalls) : '—'} detail="paid calls, all time" tone="purple" icon="earnings" />
        <Metric label="Total API Revenue" value={`$${sellerEarnings ? formatUsdc(sellerEarnings.total_earnings) : '—'}`} detail="all-time gross purchase total" tone="pink" icon="balance" />
      </div>

      {loading ? <p className="text-[#6B7280]">Loading...</p> : (
        <div className={`${styles.activity} space-y-10`}>
          <section className={styles.apiSection}>
            <div className={styles.apiSectionHeading}>
              <div><h2>My Listed APIs</h2><p>Your services, ready for the world.</p></div>
            </div>
            {myApis.length === 0 ? (
              <div className={styles.apiEmptyState}><p className="text-[#6B7280] text-sm">You haven&apos;t listed any APIs yet.</p></div>
            ) : (
              <div className={styles.apiTableShell}>
                <table className="w-full whitespace-nowrap text-sm">
                  <thead className="border-b border-[#2775CA]"><tr className="text-left text-[#6B7280]">
                    <th className="px-6 py-4 font-medium">Name</th><th className="px-6 py-4 font-medium">Category</th><th className="px-6 py-4 font-medium">Price/call</th><th className="px-6 py-4 font-medium">Calls</th><th className="px-6 py-4 font-medium">Success</th><th className="px-6 py-4 font-medium">Earned</th><th className="px-6 py-4 font-medium">Status</th><th className="px-6 py-4 font-medium">Actions</th>
                  </tr></thead>
                  <tbody>{myApis.map(api => {
                    const earning = sellerEarnings?.earnings_by_api.find(entry => entry.api_id === api.id)
                    const calls = sellCallGroups.find(group => group.api_id === api.id)
                    return <tr key={api.id} className="border-b border-[#2775CA] last:border-0 hover:bg-[#F5F5F0]">
                      <td className="px-6 py-4 font-medium text-[#0D0D0D]">{api.name}{api.request_contract_error && <span className="ml-2 rounded-full bg-[#FFF7ED] px-2 py-1 text-xs text-[#B54708]" title={api.request_contract_error}>Fix request contract</span>}</td><td className="px-6 py-4 text-[#6B7280]">{api.category}</td><td className="px-6 py-4 text-[#0D0D0D]">${api.price_per_call} USDC</td><td className="px-6 py-4 text-[#0D0D0D]">{earning?.calls ?? '—'}</td>
                      <td className="px-6 py-4">{calls ? <span className={`px-2 py-1 rounded-full text-xs font-medium ${successTone(calls.successRate)}`}>{calls.successRate}%</span> : <span className="text-[#6B7280]">—</span>}</td>
                      <td className="px-6 py-4 font-medium text-[#00B050]">{earning ? `$${formatUsdc(earning.total)}` : `$${formatUsdc(0)}`}</td>
                      <td className="px-6 py-4"><span className={`rounded-full px-2 py-1 text-xs font-medium ${api.request_contract_error ? 'bg-[#FFF7ED] text-[#B54708]' : api.is_active ? 'bg-[#F0FDF4] text-[#16A34A]' : 'bg-[#FEF2F2] text-[#DC2626]'}`}>{api.request_contract_error ? 'Needs correction' : api.is_active ? 'Active' : 'Inactive'}</span></td>
                      <td className="px-6 py-4"><ApiRowActions
                        active={api.is_active}
                        onToggle={() => toggleActive(api.id, api.is_active)}
                        onEdit={() => { void beginEditApi(api.id) }}
                        onDelete={() => { setDeletingApiId(api.id); setDeleteConfirmText('') }}
                      /></td>
                    </tr>
                  })}</tbody>
                </table>
              </div>
            )}
          </section>

          <div className={styles.apiActivitySection}><ActivityTable title="Recent Buys" empty="No API calls yet." groups={callGroups} buyer onDetails={setDetailsApi} onView={handleViewApi} /></div>
          <div className={styles.apiActivitySection}><ActivityTable title="Recent Sells" empty="No one has called your APIs yet." groups={sellCallGroups} onDetails={setDetailsSellApi} /></div>
        </div>
      )}

      {deletingApiId !== null && (() => { const api = myApis.find(item => item.id === deletingApiId); return api ? <DeleteModal apiName={api.name} value={deleteConfirmText} setValue={setDeleteConfirmText} apiActionError={apiActionError} onClose={() => { setDeletingApiId(null); setDeleteConfirmText(''); setApiActionError(null) }} onDelete={handleDeleteConfirm} /> : null })()}
      {detailsApi !== null && (() => { const group = callGroups.find(item => item.apiId === detailsApi); return group ? <BuyDetailsModal group={group} onClose={() => setDetailsApi(null)} /> : null })()}
      {detailsSellApi !== null && (() => { const group = sellCallGroups.find(item => item.api_id === detailsSellApi); return group ? <SellDetailsModal group={group} onClose={() => setDetailsSellApi(null)} /> : null })()}
      {viewApiModal && <ViewApiModal name={viewApiModal.apiName} response={viewApiResponse} loading={viewApiLoading} code={viewCodeSnippet} copied={viewApiCopied} onClose={() => setViewApiModal(null)} onCopy={() => { void navigator.clipboard.writeText(viewCodeSnippet); setViewApiCopied(true); setTimeout(() => setViewApiCopied(false), 2000) }} />}
    </div>
  )
}

function Metric({ label, value, detail, tone, icon }: { label: string; value: string; detail: string; tone: 'blue' | 'green' | 'pink' | 'purple'; icon: 'apis' | 'dashboard' | 'earnings' | 'balance' }) {
  return <section className={styles.card}><DashboardCardHeader title={label} subtitle={detail} icon={icon} tone={tone} /><div className="font-mono text-2xl font-bold tabular-nums text-[#0D0D0D]">{value}</div></section>
}

function ApiRowActions({ active, onToggle, onEdit, onDelete }: { active: boolean; onToggle: () => void | Promise<void>; onEdit: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', closeOnOutsideClick)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  const run = (action: () => void | Promise<void>) => {
    setOpen(false)
    void action()
  }

  return (
    <div ref={menuRef} className={styles.apiActionMenu}>
      <button type="button" aria-label="Open API actions" aria-expanded={open} onClick={() => setOpen(current => !current)} className={styles.apiActionMenuTrigger}>•••</button>
      {open && (
        <div role="menu" className={styles.apiActionMenuPanel}>
          <button type="button" role="menuitem" onClick={() => run(onEdit)} className={styles.apiActionMenuItem}>Edit</button>
          <button type="button" role="menuitem" onClick={() => run(onToggle)} className={styles.apiActionMenuItem}>{active ? 'Deactivate' : 'Activate'}</button>
          <button type="button" role="menuitem" onClick={() => run(onDelete)} className={`${styles.apiActionMenuItem} ${styles.apiActionMenuItemDanger}`}>Delete</button>
        </div>
      )}
    </div>
  )
}

function ActivityTable({ title, empty, groups, buyer, onDetails, onView }: { title: string; empty: string; groups: Array<{ apiId?: string; api_id?: string; name?: string; api_name?: string; count: number; avgLatency: number; successRate: number; lastCalled: string; spent?: number; method?: string }>; buyer?: boolean; onDetails: (id: string) => void; onView?: (id: string, name: string, method: string) => Promise<void> }) {
  const { formatUsdc } = useProductPreferences()
  return <section><h2 className="mb-4 text-lg font-bold text-[#0D0D0D]">{title}</h2>{groups.length === 0 ? <div className="bg-white border border-[#2775CA] rounded-xl p-8 text-center"><p className="text-[#6B7280] text-sm">{empty}</p></div> : <div className="bg-[#FAFAF8] border border-[#2775CA] rounded-xl overflow-x-auto"><table className="w-full whitespace-nowrap text-sm"><thead className="border-b border-[#2775CA]"><tr className="text-left text-[#6B7280]"><th className="px-6 py-4 font-medium">API</th><th className="px-6 py-4 font-medium">Calls</th><th className="px-6 py-4 font-medium">Avg Latency</th><th className="px-6 py-4 font-medium">Success</th>{buyer && <th className="px-6 py-4 font-medium">Spent</th>}<th className="px-6 py-4 font-medium">Last Called</th><th className="px-6 py-4 font-medium"></th></tr></thead><tbody>{groups.map(group => { const id = group.apiId ?? group.api_id ?? ''; const name = group.name ?? group.api_name ?? 'Unknown'; return <tr key={id} className="border-b border-[#2775CA] hover:bg-[#F5F5F0]"><td className="px-6 py-4 font-medium text-[#0D0D0D]">{name}</td><td className="px-6 py-4 text-[#0D0D0D]">{group.count}</td><td className="px-6 py-4 text-[#0D0D0D]">{group.avgLatency}ms</td><td className="px-6 py-4"><span className={`px-2 py-1 rounded-full text-xs font-medium ${successTone(group.successRate)}`}>{group.successRate}%</span></td>{buyer && <td className="px-6 py-4 text-[#0D0D0D]">${formatUsdc(group.spent ?? 0)}</td>}<td className="px-6 py-4 text-[#6B7280]">{new Date(group.lastCalled).toLocaleString()}</td><td className="px-6 py-4"><div className="flex gap-2"><button onClick={() => onDetails(id)} className="bg-[#00B050] hover:bg-[#008F42] text-white px-3 py-1 rounded-lg text-xs font-medium transition-colors">Details</button>{buyer && onView && <button onClick={() => void onView(id, name, group.method ?? 'GET')} className="bg-[#2775CA] hover:bg-[#1E63B5] text-white px-3 py-1 rounded-lg text-xs font-medium transition-colors">View API</button>}</div></td></tr> })}</tbody></table></div>}</section>
}

function DeleteModal({ apiName, value, setValue, apiActionError, onClose, onDelete }: { apiName: string; value: string; setValue: (value: string) => void; apiActionError: string | null; onClose: () => void; onDelete: () => Promise<void> }) {
  return <Modal narrow onClose={onClose}><div className="px-6 py-4 border-b border-[#2775CA]"><span className="font-bold text-[#0D0D0D]">Delete API</span></div><div className="px-6 py-5 space-y-4"><p className="text-sm text-[#0D0D0D]">Are you sure you want to delete <span className="font-bold">&apos;{apiName}&apos;</span>? This action cannot be undone.</p><Field label="Type DELETE to confirm"><input value={value} onChange={e => setValue(e.target.value)} placeholder="DELETE" className={inputCls} /></Field>{apiActionError && <p className="text-xs text-[#DC2626]">{apiActionError}</p>}</div><div className="px-6 py-4 border-t border-[#2775CA] flex gap-3 justify-end"><button onClick={onClose} className="px-4 py-2 rounded-lg text-sm font-medium border border-[#2775CA] text-[#6B7280]">Cancel</button><button onClick={() => { void onDelete() }} disabled={value !== 'DELETE'} className="px-4 py-2 rounded-lg text-sm font-medium bg-[#DC2626] text-white disabled:opacity-50">Delete</button></div></Modal>
}

function BuyDetailsModal({ group, onClose }: { group: { name: string; calls: Array<{ id: string; created_at: string; latency_ms: number; success: boolean }> }; onClose: () => void }) { return <Modal wide onClose={onClose}><ModalTitle title={`${group.name}: Call History`} onClose={onClose} /><CallTable calls={group.calls} /></Modal> }
function SellDetailsModal({ group, onClose }: { group: { api_name: string; calls: Array<{ id: string; created_at: string; latency_ms: number; success: boolean }> }; onClose: () => void }) { return <Modal wide onClose={onClose}><ModalTitle title={`${group.api_name}: Incoming Calls`} onClose={onClose} /><div className="overflow-y-auto max-h-[60vh]"><table className="w-full text-sm"><thead className="border-b border-[#2775CA] sticky top-0 bg-white"><tr className="text-left text-[#6B7280]"><th className="px-6 py-3 font-medium">Time</th><th className="px-6 py-3 font-medium">Latency</th><th className="px-6 py-3 font-medium">Status</th></tr></thead><tbody>{group.calls.map(call => <tr key={call.id} className="border-b border-[#2775CA]"><td className="px-6 py-3 text-[#6B7280]">{new Date(call.created_at).toLocaleString()}</td><td className="px-6 py-3 text-[#0D0D0D]">{call.latency_ms}ms</td><td className="px-6 py-3"><span className={`px-2 py-1 rounded-full text-xs font-medium ${call.success ? 'bg-[#F0FDF4] text-[#16A34A]' : 'bg-[#FEF2F2] text-[#DC2626]'}`}>{call.success ? 'Success' : 'Failed'}</span></td></tr>)}</tbody></table></div></Modal> }
function ViewApiModal({ name, response, loading, code, copied, onClose, onCopy }: { name: string; response: unknown; loading: boolean; code: string; copied: boolean; onClose: () => void; onCopy: () => void }) { return <Modal onClose={onClose}><ModalTitle title={name} onClose={onClose} /><div className="p-6 space-y-5"><div><h3 className="text-sm font-medium text-[#0D0D0D] mb-2">Last Response</h3>{loading ? <p className="text-sm text-[#6B7280]">Loading...</p> : response !== null ? <pre className="bg-[#F5F5F0] rounded-lg p-4 text-sm text-[#0D0D0D] overflow-x-auto whitespace-pre-wrap max-h-48 overflow-y-auto">{JSON.stringify(response, null, 2)}</pre> : <p className="text-sm text-[#6B7280]">No response data available yet.</p>}</div><div><h3 className="text-sm font-medium text-[#0D0D0D] mb-2">Integration Code</h3><pre className="bg-[#0D0D0D] text-[#E2E4E9] text-xs rounded-xl p-4 overflow-x-auto whitespace-pre leading-relaxed">{renderHighlightedSnippet(code)}</pre><button onClick={onCopy} className={`mt-3 w-full py-2 rounded-lg text-sm font-medium border transition-colors ${copied ? 'bg-[#F0FDF4] border-[#86EFAC] text-[#16A34A]' : 'bg-white border-[#2775CA] text-[#6B7280]'}`}>{copied ? 'Copied!' : 'Copy to clipboard'}</button></div></div></Modal> }
function Modal({ children, narrow, wide, onClose }: { children: React.ReactNode; narrow?: boolean; wide?: boolean; onClose: () => void }) { return <div className="fixed inset-0 z-50 flex items-center justify-center p-4"><div className="absolute inset-0 bg-black/50" onClick={onClose} /><div className={`relative w-full overflow-hidden rounded-2xl bg-white shadow-xl ${narrow ? 'max-w-md' : wide ? 'max-w-2xl' : 'max-w-lg'}`}>{children}</div></div> }
function ModalTitle({ title, onClose }: { title: string; onClose: () => void }) { return <div className="px-6 py-4 border-b border-[#2775CA] flex items-center justify-between"><span className="font-bold text-[#0D0D0D]">{title}</span><button onClick={onClose} className="text-[#6B7280] text-xl leading-none">&times;</button></div> }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div className="space-y-1.5"><label className="block text-sm font-medium text-[#0D0D0D]">{label}</label>{children}</div> }
function CallTable({ calls }: { calls: Array<{ id: string; created_at: string; latency_ms: number; success: boolean }> }) { return <div className="overflow-y-auto max-h-[60vh]"><table className="w-full text-sm"><thead className="border-b border-[#2775CA] sticky top-0 bg-white"><tr className="text-left text-[#6B7280]"><th className="px-6 py-3 font-medium">Time</th><th className="px-6 py-3 font-medium">Latency</th><th className="px-6 py-3 font-medium">Status</th></tr></thead><tbody>{calls.map(call => <tr key={call.id} className="border-b border-[#2775CA]"><td className="px-6 py-3 text-[#6B7280]">{new Date(call.created_at).toLocaleString()}</td><td className="px-6 py-3 text-[#0D0D0D]">{call.latency_ms}ms</td><td className="px-6 py-3"><span className={`px-2 py-1 rounded-full text-xs font-medium ${call.success ? 'bg-[#F0FDF4] text-[#16A34A]' : 'bg-[#FEF2F2] text-[#DC2626]'}`}>{call.success ? 'Success' : 'Failed'}</span></td></tr>)}</tbody></table></div> }
