'use client';

import { useAccount } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { NavBar } from '@/components/NavBar';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardContent } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';

const ADMIN_WALLET = '0x540a0027509b1c9aa0a2c5c65491cc97083e16de';
const CATEGORIES = ['AI', 'Data', 'Finance', 'Weather', 'Geo', 'Social', 'Media', 'Utility', 'Other'];
const PAGE_SIZE = 20;

// Adds x-admin-key header to discovery API calls when NEXT_PUBLIC_ADMIN_SECRET is configured
const ADMIN_KEY = process.env.NEXT_PUBLIC_ADMIN_SECRET;
function aFetch(url: string, init?: RequestInit): Promise<Response> {
  if (!ADMIN_KEY) return fetch(url, init);
  const h = new Headers(init?.headers);
  h.set('x-admin-key', ADMIN_KEY);
  return fetch(url, { ...init, headers: h });
}

interface DiscoveryListing {
  id: string;
  name: string;
  description: string;
  category: string;
  price_per_call: number;
  is_active: boolean;
  score: number | null;
  seller_wallet: string;
  endpoint_url: string;
  method: string | null;
  source: string;
  hourly_limit: number | null;
  latency_ms: number | null;
  created_at: string;
  total_calls: number;
  successful_calls: number;
  api_docs_url: string | null;
  source_name: string | null;
}

interface SummaryStats {
  total_all: number;
  active: number;
  inactive: number;
  total_calls: number;
}

interface EditForm {
  name: string;
  description: string;
  price_per_call: string;
  category: string;
}

interface RetestProgress {
  tested: number;
  reactivated: number;
  remaining: number;
}

interface ActivateProgress {
  tested: number;
  activated: number;
  removed: number;
  remaining: number;
}

interface ApiResponse {
  listings?: DiscoveryListing[];
  total?: number;
  summary?: SummaryStats;
  categories?: string[];
  error?: string;
}

type StatusFilter = 'all' | 'active' | 'inactive';

export default function DiscoveryListingsPage() {
  const { address, isConnected } = useAccount();

  // ── Data ──────────────────────────────────────────────────────
  const [listings, setListings] = useState<DiscoveryListing[]>([]);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState<SummaryStats | null>(null);
  const [availableCategories, setAvailableCategories] = useState<string[]>(['All']);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // ── Card actions ──────────────────────────────────────────────
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<EditForm | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});

  // ── Filters ───────────────────────────────────────────────────
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('All');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [page, setPage] = useState(1);

  // ── Retest ────────────────────────────────────────────────────
  const [retesting, setRetesting] = useState(false);
  const [retestProgress, setRetestProgress] = useState<RetestProgress | null>(null);
  const retestStopRef = useRef(false);

  // ── Activate ──────────────────────────────────────────────────
  const [activating, setActivating] = useState(false);
  const [activateProgress, setActivateProgress] = useState<ActivateProgress | null>(null);
  const activateStopRef = useRef(false);

  // ── Fetch ─────────────────────────────────────────────────────
  const loadListings = useCallback(async (
    p: number,
    s: string,
    c: string,
    st: StatusFilter,
  ) => {
    setLoading(true);
    setFetchError(null);
    const params = new URLSearchParams();
    params.set('page', String(p));
    if (s) params.set('search', s);
    if (c !== 'All') params.set('category', c);
    if (st !== 'all') params.set('status', st);

    try {
      const res = await aFetch(`/api/discovery/listings?${params.toString()}`);
      const data = await res.json() as ApiResponse;
      if (!res.ok) {
        setFetchError(data.error ?? `Error ${res.status}`);
      } else {
        setListings(data.listings ?? []);
        setTotal(data.total ?? 0);
        setSummary(data.summary ?? null);
        setAvailableCategories(['All', ...(data.categories ?? [])]);
      }
    } catch (err: unknown) {
      setFetchError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setLoading(false);
    }
  }, []);

  const refresh = useCallback(() => {
    void loadListings(page, search, categoryFilter, statusFilter);
  }, [loadListings, page, search, categoryFilter, statusFilter]);

  useEffect(() => { void loadListings(1, '', 'All', 'all'); }, [loadListings]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // ── Filter handlers ───────────────────────────────────────────
  function handleSearchChange(val: string) {
    setSearch(val);
    setPage(1);
    void loadListings(1, val, categoryFilter, statusFilter);
  }

  function handleCategoryChange(val: string) {
    setCategoryFilter(val);
    setPage(1);
    void loadListings(1, search, val, statusFilter);
  }

  function handleStatusChange(val: StatusFilter) {
    setStatusFilter(val);
    setPage(1);
    void loadListings(1, search, categoryFilter, val);
  }

  function handlePageChange(newPage: number) {
    setPage(newPage);
    void loadListings(newPage, search, categoryFilter, statusFilter);
  }

  // ── Card action helpers ───────────────────────────────────────
  function clearError(id: string) {
    setActionErrors(prev => ({ ...prev, [id]: '' }));
  }
  function setError(id: string, msg: string) {
    setActionErrors(prev => ({ ...prev, [id]: msg }));
  }

  async function handleToggle(listing: DiscoveryListing) {
    setActionLoading(listing.id);
    clearError(listing.id);
    try {
      const res = await fetch(`/api/apis/${listing.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seller_wallet: listing.seller_wallet, is_active: !listing.is_active }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) {
        setError(listing.id, data.error ?? `Error ${res.status}`);
      } else {
        refresh();
      }
    } catch (err: unknown) {
      setError(listing.id, err instanceof Error ? err.message : 'Network error');
    } finally {
      setActionLoading(null);
    }
  }

  async function handleRelist(listing: DiscoveryListing) {
    setActionLoading(listing.id);
    clearError(listing.id);
    try {
      const res = await fetch(`/api/apis/${listing.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seller_wallet: listing.seller_wallet, is_active: true }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) {
        setError(listing.id, data.error ?? `Error ${res.status}`);
      } else {
        refresh();
      }
    } catch (err: unknown) {
      setError(listing.id, err instanceof Error ? err.message : 'Network error');
    } finally {
      setActionLoading(null);
    }
  }

  function startEdit(listing: DiscoveryListing) {
    setEditingId(listing.id);
    setEditForm({
      name: listing.name,
      description: listing.description,
      price_per_call: String(listing.price_per_call),
      category: listing.category,
    });
    setConfirmDeleteId(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditForm(null);
  }

  async function handleSave(listing: DiscoveryListing) {
    if (!editForm) return;
    const price = parseFloat(editForm.price_per_call);
    if (!isFinite(price) || price <= 0) {
      setError(listing.id, 'Price must be a positive number');
      return;
    }
    setActionLoading(listing.id);
    clearError(listing.id);
    try {
      const res = await fetch(`/api/apis/${listing.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          seller_wallet: listing.seller_wallet,
          name: editForm.name.trim(),
          description: editForm.description.trim(),
          price_per_call: price,
          category: editForm.category,
        }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) {
        setError(listing.id, data.error ?? `Error ${res.status}`);
      } else {
        cancelEdit();
        refresh();
      }
    } catch (err: unknown) {
      setError(listing.id, err instanceof Error ? err.message : 'Network error');
    } finally {
      setActionLoading(null);
    }
  }

  async function handleDelete(listing: DiscoveryListing) {
    setActionLoading(listing.id);
    clearError(listing.id);
    try {
      const res = await fetch(`/api/apis/${listing.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seller_wallet: listing.seller_wallet }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) {
        setError(listing.id, data.error ?? `Error ${res.status}`);
        setConfirmDeleteId(null);
      } else {
        setConfirmDeleteId(null);
        refresh();
      }
    } catch (err: unknown) {
      setError(listing.id, err instanceof Error ? err.message : 'Network error');
    } finally {
      setActionLoading(null);
    }
  }

  // ── Retest ────────────────────────────────────────────────────
  async function handleRetestAll() {
    retestStopRef.current = false;
    setRetesting(true);
    setRetestProgress({ tested: 0, reactivated: 0, remaining: summary?.inactive ?? 0 });

    let cumTested = 0;
    let cumReactivated = 0;
    let noProgressCount = 0;
    let prevRemaining = summary?.inactive ?? 0;

    while (!retestStopRef.current) {
      let data: { tested: number; reactivated: number; remaining: number; error?: string };
      try {
        const res = await aFetch('/api/discovery/retest', { method: 'POST' });
        data = await res.json() as typeof data;
        if (!res.ok) break;
      } catch {
        break;
      }

      cumTested += data.tested;
      cumReactivated += data.reactivated;
      setRetestProgress({ tested: cumTested, reactivated: cumReactivated, remaining: data.remaining });

      if (data.remaining === 0 || data.tested === 0) break;

      if (data.remaining >= prevRemaining) {
        noProgressCount++;
        if (noProgressCount >= 3) break;
      } else {
        noProgressCount = 0;
      }
      prevRemaining = data.remaining;
    }

    setRetesting(false);
    retestStopRef.current = false;
    refresh();
  }

  // ── Activate ──────────────────────────────────────────────────
  async function handleActivateAll() {
    activateStopRef.current = false;
    setActivating(true);
    setActivateProgress({ tested: 0, activated: 0, removed: 0, remaining: summary?.inactive ?? 0 });

    let cumTested = 0;
    let cumActivated = 0;
    let cumRemoved = 0;
    let noProgressCount = 0;
    let prevRemaining = summary?.inactive ?? 0;

    while (!activateStopRef.current) {
      let data: { tested: number; activated: number; removed: number; remaining: number; error?: string };
      try {
        const res = await aFetch('/api/discovery/activate', { method: 'POST' });
        data = await res.json() as typeof data;
        if (!res.ok) break;
      } catch {
        break;
      }

      cumTested += data.tested;
      cumActivated += data.activated;
      cumRemoved += data.removed;
      setActivateProgress({
        tested: cumTested,
        activated: cumActivated,
        removed: cumRemoved,
        remaining: data.remaining,
      });

      if (data.remaining === 0 || data.tested === 0) break;

      // Stop automatically after 3 consecutive batches with no reduction in remaining
      if (data.remaining >= prevRemaining) {
        noProgressCount++;
        if (noProgressCount >= 3) break;
      } else {
        noProgressCount = 0;
      }
      prevRemaining = data.remaining;
    }

    setActivating(false);
    activateStopRef.current = false;
    refresh();
  }

  // ── Guards ────────────────────────────────────────────────────
  if (!isConnected) {
    return (
      <>
        <NavBar />
        <main className="min-h-screen bg-[#F5F5F0] flex flex-col items-center justify-center gap-6 px-6 pt-36">
          <h1 className="text-2xl font-bold text-[#0D0D0D]">Connect Your Wallet</h1>
          <p className="text-[#6B7280] text-center max-w-sm">Admin access requires a connected wallet.</p>
          <ConnectButton />
        </main>
      </>
    );
  }

  if (address?.toLowerCase() !== ADMIN_WALLET) {
    return (
      <>
        <NavBar />
        <main className="min-h-screen bg-[#F5F5F0] flex flex-col items-center justify-center gap-4 px-6 pt-36">
          <h1 className="text-2xl font-bold text-[#0D0D0D]">Access Denied</h1>
          <p className="text-[#6B7280] text-center max-w-sm">This page is restricted to the Mahshar admin wallet.</p>
          <code className="text-xs text-[#6B7280] bg-[#F0F0E8] px-3 py-1 rounded">{address}</code>
        </main>
      </>
    );
  }

  // ── Render ────────────────────────────────────────────────────
  return (
    <>
      <NavBar />
      <main className="min-h-screen bg-[#F5F5F0] px-6 pt-40 pb-16">
        <div className="mx-auto max-w-4xl">

          {/* Back link */}
          <div className="mb-6 flex items-center gap-3">
            <Link
              href="/admin/discovery"
              className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-[#00B050] hover:bg-[#008F42] text-white transition-colors"
            >
              <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                <path d="M19 12H5M12 5l-7 7 7 7"/>
              </svg>
            </Link>
          </div>

          {/* Title */}
          <h1 className="text-3xl font-bold text-[#0D0D0D] mb-6">Discovery Listings</h1>

          {/* ── Summary bar ──────────────────────────────────── */}
          {!loading && summary && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
              {([
                { label: 'Total', value: summary.total_all },
                { label: 'Active', value: summary.active },
                { label: 'Inactive', value: summary.inactive },
                { label: 'Total Calls', value: summary.total_calls },
              ] as const).map(({ label, value }) => (
                <div key={label} className="bg-white border border-[#2775CA] rounded-xl px-4 py-3 text-center">
                  <div className="text-xl font-bold text-[#0D0D0D]">{value}</div>
                  <div className="text-xs text-[#6B7280] mt-0.5">{label}</div>
                </div>
              ))}
            </div>
          )}

          {/* ── Activate Tested APIs ─────────────────────────── */}
          {!loading && summary && summary.inactive > 0 && (
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <Button
                variant="primary"
                onClick={() => void handleActivateAll()}
                disabled={activating || retesting}
              >
                {activating ? 'Activating…' : `Activate Tested APIs (${summary.inactive})`}
              </Button>
              {activating && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => { activateStopRef.current = true; }}
                >
                  Stop
                </Button>
              )}
              {activateProgress && (
                <span className="text-sm text-[#6B7280]">
                  Tested <strong>{activateProgress.tested}</strong>,{' '}
                  Activated <strong className="text-[#00B050]">{activateProgress.activated}</strong>,{' '}
                  Removed <strong className="text-red-500">{activateProgress.removed}</strong>,{' '}
                  Remaining <strong>{activateProgress.remaining}</strong>
                </span>
              )}
            </div>
          )}

          {/* ── Re-test All Inactive ─────────────────────────── */}
          {!loading && summary && summary.inactive > 0 && (
            <div className="mb-6 flex flex-wrap items-center gap-3">
              <Button
                variant="secondary"
                onClick={() => void handleRetestAll()}
                disabled={retesting || activating}
              >
                {retesting ? 'Retesting…' : `Re-test All Inactive (${summary.inactive})`}
              </Button>
              {retesting && (
                <Button variant="outline" size="sm" onClick={() => { retestStopRef.current = true; }}>
                  Stop
                </Button>
              )}
              {retestProgress && (
                <span className="text-sm text-[#6B7280]">
                  Tested <strong>{retestProgress.tested}</strong>,{' '}
                  Reactivated <strong className="text-[#00B050]">{retestProgress.reactivated}</strong>,{' '}
                  Remaining <strong>{retestProgress.remaining}</strong>
                </span>
              )}
            </div>
          )}

          {/* ── Filters ──────────────────────────────────────── */}
          {!loading && summary && summary.total_all > 0 && (
            <div className="mb-6 space-y-3">
              <input
                type="text"
                value={search}
                onChange={e => handleSearchChange(e.target.value)}
                placeholder="Search by name…"
                className="w-full bg-[#FAFAF8] border border-[#2775CA] rounded-xl px-4 py-2.5 text-sm text-[#0D0D0D] placeholder-[#6B7280] focus:outline-none focus:ring-2 focus:ring-[#2775CA]"
              />
              <div className="flex flex-wrap items-center gap-3">
                <select
                  value={categoryFilter}
                  onChange={e => handleCategoryChange(e.target.value)}
                  className="bg-[#FAFAF8] border border-[#2775CA] rounded-lg px-3 py-2 text-sm text-[#0D0D0D] focus:outline-none focus:ring-2 focus:ring-[#2775CA]"
                >
                  {availableCategories.map(c => (
                    <option key={c} value={c}>{c === 'All' ? 'All Categories' : c}</option>
                  ))}
                </select>
                <div className="flex gap-1">
                  {(['all', 'active', 'inactive'] as const).map(s => (
                    <button
                      key={s}
                      onClick={() => handleStatusChange(s)}
                      className={
                        statusFilter === s
                          ? 'bg-[#2775CA] text-white rounded-lg px-3 py-1.5 text-sm font-medium transition-colors'
                          : 'bg-white border border-[#2775CA] text-[#6B7280] rounded-lg px-3 py-1.5 text-sm font-medium hover:border-[#2775CA] transition-colors'
                      }
                    >
                      {s.charAt(0).toUpperCase() + s.slice(1)}
                    </button>
                  ))}
                </div>
                {(search || categoryFilter !== 'All' || statusFilter !== 'all') && (
                  <span className="text-sm text-[#6B7280]">
                    {total} of {summary.total_all} listings
                  </span>
                )}
              </div>
            </div>
          )}

          {/* ── States ───────────────────────────────────────── */}
          {loading && <p className="text-sm text-[#6B7280]">Loading listings…</p>}

          {fetchError && (
            <div className="bg-red-50 border border-red-200 rounded-xl px-6 py-4 text-sm text-red-600 mb-6">
              {fetchError}
            </div>
          )}

          {!loading && !fetchError && summary && summary.total_all === 0 && (
            <p className="text-sm text-[#6B7280]">
              No discovery listings yet.{' '}
              <Link href="/admin/discovery" className="text-[#2775CA] hover:underline">
                Run the crawler
              </Link>{' '}
              to populate this list.
            </p>
          )}

          {!loading && !fetchError && summary && summary.total_all > 0 && listings.length === 0 && (
            <p className="text-sm text-[#6B7280]">No listings match the current filters.</p>
          )}

          {/* ── Listing cards ─────────────────────────────────── */}
          <div className="flex flex-col gap-4">
            {listings.map(listing => {
              const isEditing = editingId === listing.id;
              const isConfirmingDelete = confirmDeleteId === listing.id;
              const busy = actionLoading === listing.id;
              const err = actionErrors[listing.id];

              return (
                <Card key={listing.id}>
                  <CardHeader>
                    <div className="flex items-start justify-between gap-3 flex-wrap">
                      {/* Name + badges */}
                      <div className="flex items-center gap-2 flex-wrap min-w-0">
                        <span className="font-bold text-[#0D0D0D] truncate">{listing.name}</span>
                        <Badge variant="blue">{listing.category}</Badge>
                        {listing.source_name && (
                          <Badge variant="default">{listing.source_name}</Badge>
                        )}
                        {listing.is_active
                          ? <Badge variant="success">Active</Badge>
                          : <Badge variant="error">Inactive</Badge>}
                      </div>

                      {/* Action buttons */}
                      <div className="flex items-center gap-2 flex-wrap flex-shrink-0">
                        {listing.api_docs_url && (
                          <a
                            href={listing.api_docs_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-sm font-medium text-[#2775CA] hover:underline"
                          >
                            View Source
                          </a>
                        )}

                        <Button
                          variant={listing.is_active ? 'outline' : 'secondary'}
                          size="sm"
                          disabled={busy}
                          onClick={() => void handleToggle(listing)}
                        >
                          {busy && !isConfirmingDelete && !isEditing
                            ? '…'
                            : listing.is_active ? 'Deactivate' : 'Activate'}
                        </Button>

                        {!listing.is_active && (
                          <Button
                            variant="accent"
                            size="sm"
                            disabled={busy}
                            onClick={() => void handleRelist(listing)}
                          >
                            Re-list
                          </Button>
                        )}

                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy || isConfirmingDelete}
                          onClick={() => (isEditing ? cancelEdit() : startEdit(listing))}
                        >
                          {isEditing ? 'Cancel' : 'Edit'}
                        </Button>

                        <button
                          disabled={busy || isEditing}
                          onClick={() =>
                            setConfirmDeleteId(isConfirmingDelete ? null : listing.id)
                          }
                          className="text-sm font-medium text-red-500 hover:text-red-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  </CardHeader>

                  <CardContent>
                    {/* Normal view */}
                    {!isEditing && (
                      <>
                        <p className="text-sm text-[#6B7280] mb-4 line-clamp-3" title={listing.description}>
                          {listing.description}
                        </p>
                        <div className="flex flex-wrap gap-6 text-sm">
                          <div>
                            <span className="text-[#6B7280]">Price </span>
                            <span className="font-semibold text-[#0D0D0D]">
                              ${listing.price_per_call} USDC/call
                            </span>
                          </div>
                          <div>
                            <span className="text-[#6B7280]">Score </span>
                            <span className="font-semibold text-[#2775CA]">
                              {listing.score != null ? `${listing.score}/10` : '—'}
                            </span>
                          </div>
                          {listing.latency_ms != null && (
                            <div>
                              <span className="text-[#6B7280]">Latency </span>
                              <span className="font-semibold text-[#0D0D0D]">{listing.latency_ms}ms</span>
                            </div>
                          )}
                          <div>
                            <span className="text-[#6B7280]">Calls </span>
                            <span className="font-semibold text-[#0D0D0D]">{listing.total_calls}</span>
                            {listing.total_calls > 0 && (
                              <span className="text-[#6B7280]">
                                {' '}({listing.successful_calls} successful)
                              </span>
                            )}
                          </div>
                          {listing.hourly_limit != null && (
                            <div>
                              <span className="text-[#6B7280]">Hourly limit </span>
                              <span className="font-semibold text-[#0D0D0D]">{listing.hourly_limit}</span>
                            </div>
                          )}
                        </div>
                      </>
                    )}

                    {/* Inline edit form */}
                    {isEditing && editForm && (
                      <div className="space-y-4">
                        <div>
                          <label className="block text-xs font-medium text-[#6B7280] mb-1">Name</label>
                          <input
                            type="text"
                            value={editForm.name}
                            onChange={e =>
                              setEditForm(f => f ? { ...f, name: e.target.value } : f)
                            }
                            className="w-full bg-white border border-[#2775CA] rounded-lg px-3 py-2 text-sm text-[#0D0D0D] focus:outline-none focus:ring-2 focus:ring-[#2775CA]"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-[#6B7280] mb-1">Category</label>
                          <select
                            value={editForm.category}
                            onChange={e =>
                              setEditForm(f => f ? { ...f, category: e.target.value } : f)
                            }
                            className="w-full bg-white border border-[#2775CA] rounded-lg px-3 py-2 text-sm text-[#0D0D0D] focus:outline-none focus:ring-2 focus:ring-[#2775CA]"
                          >
                            {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                          </select>
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-[#6B7280] mb-1">Description</label>
                          <textarea
                            value={editForm.description}
                            onChange={e =>
                              setEditForm(f => f ? { ...f, description: e.target.value } : f)
                            }
                            rows={3}
                            className="w-full bg-white border border-[#2775CA] rounded-lg px-3 py-2 text-sm text-[#0D0D0D] focus:outline-none focus:ring-2 focus:ring-[#2775CA] resize-none"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-[#6B7280] mb-1">
                            Price per call (USDC)
                          </label>
                          <input
                            type="number"
                            step="0.001"
                            min="0.001"
                            value={editForm.price_per_call}
                            onChange={e =>
                              setEditForm(f => f ? { ...f, price_per_call: e.target.value } : f)
                            }
                            className="w-full bg-white border border-[#2775CA] rounded-lg px-3 py-2 text-sm text-[#0D0D0D] focus:outline-none focus:ring-2 focus:ring-[#2775CA]"
                          />
                        </div>
                        <div className="flex gap-2 pt-1">
                          <Button
                            variant="primary"
                            size="sm"
                            disabled={busy}
                            onClick={() => void handleSave(listing)}
                          >
                            {busy ? 'Saving…' : 'Save'}
                          </Button>
                          <Button variant="ghost" size="sm" onClick={cancelEdit}>
                            Cancel
                          </Button>
                        </div>
                      </div>
                    )}

                    {/* Inline delete confirmation */}
                    {isConfirmingDelete && !isEditing && (
                      <div className="mt-4 flex items-center gap-4 bg-red-50 border border-red-200 rounded-lg px-4 py-3">
                        <span className="text-sm text-red-700 flex-1">
                          Delete <strong>{listing.name}</strong>? This cannot be undone.
                        </span>
                        <button
                          disabled={busy}
                          onClick={() => void handleDelete(listing)}
                          className="text-sm font-semibold text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 px-3 py-1.5 rounded-lg transition-colors"
                        >
                          {busy ? 'Deleting…' : 'Confirm Delete'}
                        </button>
                        <button
                          onClick={() => setConfirmDeleteId(null)}
                          className="text-sm text-red-600 hover:text-red-800 transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                    )}

                    {/* Per-card error */}
                    {err && (
                      <p className="mt-3 text-xs text-red-600">{err}</p>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>

          {/* ── Pagination ────────────────────────────────────── */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-8">
              <Button
                variant="secondary"
                size="sm"
                disabled={page <= 1}
                onClick={() => handlePageChange(Math.max(1, page - 1))}
              >
                ← Previous
              </Button>
              <span className="text-sm text-[#6B7280]">
                Page {page} of {totalPages}
                {' '}· {total} result{total !== 1 ? 's' : ''}
              </span>
              <Button
                variant="secondary"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => handlePageChange(Math.min(totalPages, page + 1))}
              >
                Next →
              </Button>
            </div>
          )}

        </div>
      </main>
    </>
  );
}
