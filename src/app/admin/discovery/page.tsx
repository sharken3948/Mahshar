'use client';

import { useAccount } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useState, useEffect, useCallback } from 'react';
import { NavBar } from '@/components/NavBar';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardContent } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';

const ADMIN_WALLET = '0x540a0027509b1c9aa0a2c5c65491cc97083e16de';

// Adds x-admin-key header to discovery API calls when NEXT_PUBLIC_ADMIN_SECRET is configured
const ADMIN_KEY = process.env.NEXT_PUBLIC_ADMIN_SECRET;
function aFetch(url: string, init?: RequestInit): Promise<Response> {
  if (!ADMIN_KEY) return fetch(url, init);
  const h = new Headers(init?.headers);
  h.set('x-admin-key', ADMIN_KEY);
  return fetch(url, { ...init, headers: h });
}

interface CrawlStats {
  total: number;
  pending: number;
  listed: number;
  rejected: number;
}

interface CrawlRow {
  id: string;
  name: string;
  endpoint_url: string;
  status: string;
  score: number | null;
  reject_reason: string | null;
  created_at: string;
}

interface DiscoveredApi {
  id: string;
  api_name: string | null;
  owner_github: string | null;
  owner_email: string | null;
  owner_x: string | null;
  invited: boolean;
  created_at: string;
}

interface BatchResult {
  processed: number;
  listed: number;
  rejected: number;
  skipped: number;
  next_offset: number;
  total_pending: number;
}

function statusBadge(status: string) {
  if (status === 'listed') return <Badge variant="success">listed</Badge>;
  if (status === 'rejected') return <Badge variant="error">rejected</Badge>;
  return <Badge variant="default">pending</Badge>;
}

function invitedBadge(invited: boolean) {
  return invited
    ? <Badge variant="success">Invited</Badge>
    : <Badge variant="default">Not invited</Badge>;
}

export default function DiscoveryAdminPage() {
  const { address, isConnected } = useAccount();

  const [stats, setStats] = useState<CrawlStats | null>(null);
  const [crawlRows, setCrawlRows] = useState<CrawlRow[]>([]);
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ batch: number; listed: number; rejected: number; skipped: number }[]>([]);
  const [batchSummary, setBatchSummary] = useState<{ listed: number; rejected: number; skipped: number } | null>(null);
  const [batchError, setBatchError] = useState<string | null>(null);

  const [discoveredApis, setDiscoveredApis] = useState<DiscoveredApi[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<{ new: number; existing: number } | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);

  const [outreachRunning, setOutreachRunning] = useState(false);
  const [outreachResult, setOutreachResult] = useState<{ sent: number; skipped: number } | null>(null);
  const [outreachError, setOutreachError] = useState<string | null>(null);

  const refreshCrawlData = useCallback(async () => {
    try {
      const res = await aFetch('/api/discovery/crawl');
      if (!res.ok) return;
      const data = await res.json() as { stats: CrawlStats; rows: CrawlRow[] };
      setStats(data.stats ?? null);
      setCrawlRows(data.rows ?? []);
    } catch {
      // network error — leave existing data in place
    }
  }, []);

  const refreshScanData = useCallback(async () => {
    try {
      const res = await aFetch('/api/discovery/scan');
      if (!res.ok) return;
      const data = await res.json() as { apis: DiscoveredApi[] };
      setDiscoveredApis(data.apis ?? []);
    } catch {
      // network error — leave existing data in place
    }
  }, []);

  useEffect(() => {
    void refreshCrawlData();
    void refreshScanData();
  }, [refreshCrawlData, refreshScanData]);

  async function handleRunBatch() {
    setBatchRunning(true);
    setBatchProgress([]);
    setBatchSummary(null);
    setBatchError(null);

    let totalListed = 0;
    let totalRejected = 0;
    let totalSkipped = 0;

    for (let i = 0; i < 5; i++) {
      try {
        const res = await aFetch('/api/discovery/crawl?batch_size=10', { method: 'POST' });
        const data = await res.json() as BatchResult & { error?: string };
        if (!res.ok) {
          setBatchError(data.error ?? `Error ${res.status}`);
          break;
        }
        totalListed += data.listed;
        totalRejected += data.rejected;
        totalSkipped += data.skipped;
        setBatchProgress(prev => [...prev, { batch: i + 1, listed: data.listed, rejected: data.rejected, skipped: data.skipped }]);
      } catch (err: unknown) {
        setBatchError(err instanceof Error ? err.message : 'Network error');
        break;
      }
    }

    setBatchSummary({ listed: totalListed, rejected: totalRejected, skipped: totalSkipped });
    await refreshCrawlData();
    setBatchRunning(false);
  }

  async function handleScan() {
    setScanning(true);
    setScanResult(null);
    setScanError(null);
    try {
      const res = await aFetch('/api/discovery/scan', { method: 'POST' });
      const data = await res.json() as { new: number; existing: number; error?: string };
      if (!res.ok) {
        setScanError(data.error ?? `Error ${res.status}`);
      } else {
        setScanResult(data);
        await refreshScanData();
      }
    } catch (err: unknown) {
      setScanError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setScanning(false);
    }
  }

  async function handleOutreach() {
    setOutreachRunning(true);
    setOutreachResult(null);
    setOutreachError(null);
    try {
      const res = await aFetch('/api/discovery/outreach', { method: 'POST' });
      const data = await res.json() as { sent: number; skipped: number; error?: string };
      if (!res.ok) {
        setOutreachError(data.error ?? `Error ${res.status}`);
      } else {
        setOutreachResult(data);
        await refreshScanData();
      }
    } catch (err: unknown) {
      setOutreachError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setOutreachRunning(false);
    }
  }

  if (!isConnected) {
    return (
      <>
        <NavBar />
        <main className="min-h-screen bg-[#F5F5F0] flex flex-col items-center justify-center gap-6 px-6 pt-36">
          <h1 className="text-2xl font-bold text-[#0D0D0D]">Connect Your Wallet</h1>
          <p className="text-[#6B7280] text-center max-w-sm">
            Admin access requires a connected wallet.
          </p>
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
          <p className="text-[#6B7280] text-center max-w-sm">
            This page is restricted to the Mahshar admin wallet.
          </p>
          <code className="text-xs text-[#6B7280] bg-[#F0F0E8] px-3 py-1 rounded">
            {address}
          </code>
        </main>
      </>
    );
  }

  return (
    <>
      <NavBar />
      <main className="min-h-screen bg-[#F5F5F0] px-6 pt-40 pb-16">
        <div className="mx-auto max-w-5xl space-y-8">
          <h1 className="text-3xl font-bold text-[#0D0D0D]">Discovery Dashboard</h1>

          {/* ── Phase 1: Crawl ── */}
          <Card>
            <CardHeader>
              <h2 className="text-xl font-bold text-[#0D0D0D]">Phase 1 — Crawl Public APIs</h2>
            </CardHeader>
            <CardContent>

              {/* Stats */}
              {stats && (
                <div className="grid grid-cols-4 gap-4 mb-6">
                  {(['total', 'pending', 'listed', 'rejected'] as const).map(key => (
                    <div key={key} className="bg-white border border-[#2775CA] rounded-xl p-4 text-center">
                      <div className="text-2xl font-bold text-[#0D0D0D]">{stats[key]}</div>
                      <div className="text-xs text-[#6B7280] mt-1 capitalize">{key}</div>
                    </div>
                  ))}
                </div>
              )}

              {/* Run 50 APIs */}
              <div className="flex flex-col gap-3 mb-4">
                <div className="flex items-center gap-4">
                  <Button onClick={() => void handleRunBatch()} disabled={batchRunning}>
                    {batchRunning ? 'Running…' : 'Run 50 APIs'}
                  </Button>
                  {batchError && (
                    <span className="text-sm text-red-600">{batchError}</span>
                  )}
                </div>
                {(batchProgress.length > 0 || batchRunning) && (
                  <div className="space-y-1 pl-1">
                    {batchProgress.map(p => (
                      <div key={p.batch} className="text-sm text-[#6B7280]">
                        Batch {p.batch}/5: Listed {p.listed}, Rejected {p.rejected}
                        {p.skipped > 0 && `, Skipped ${p.skipped}`}
                      </div>
                    ))}
                    {batchRunning && batchProgress.length < 5 && (
                      <div className="text-sm text-[#6B7280] animate-pulse">
                        Batch {batchProgress.length + 1}/5: running…
                      </div>
                    )}
                    {batchSummary && !batchRunning && (
                      <div className="text-sm font-medium text-[#0D0D0D] pt-1 border-t border-[#F0F0E8]">
                        Total: Listed {batchSummary.listed}, Rejected {batchSummary.rejected}
                        {batchSummary.skipped > 0 && `, Skipped ${batchSummary.skipped}`}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Crawl queue table */}
              {crawlRows.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-[#2775CA]">
                        <th className="text-left py-2 pr-4 text-[#6B7280] font-medium">API Name</th>
                        <th className="text-left py-2 pr-4 text-[#6B7280] font-medium">Endpoint</th>
                        <th className="text-left py-2 pr-4 text-[#6B7280] font-medium">Status</th>
                        <th className="text-left py-2 pr-4 text-[#6B7280] font-medium">Score</th>
                        <th className="text-left py-2 text-[#6B7280] font-medium">Added</th>
                      </tr>
                    </thead>
                    <tbody>
                      {crawlRows.map(row => (
                        <tr key={row.id} className="border-b border-[#F0F0E8]">
                          <td className="py-2 pr-4 font-medium text-[#0D0D0D] max-w-[160px] truncate">
                            {row.name}
                          </td>
                          <td className="py-2 pr-4 text-[#6B7280] max-w-[200px] truncate">
                            <a
                              href={row.endpoint_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="hover:text-[#2775CA] transition-colors"
                            >
                              {row.endpoint_url}
                            </a>
                          </td>
                          <td className="py-2 pr-4">{statusBadge(row.status)}</td>
                          <td className="py-2 pr-4 text-[#0D0D0D]">
                            {row.score != null ? `${row.score}/10` : '—'}
                          </td>
                          <td className="py-2 text-[#6B7280]">
                            {new Date(row.created_at).toLocaleDateString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {crawlRows.length === 0 && (
                <p className="text-sm text-[#6B7280]">
                  No rows yet — click Run 50 APIs to seed and process the queue.
                </p>
              )}

            </CardContent>
          </Card>

          {/* ── Phase 2: Scan & Outreach ── */}
          <Card>
            <CardHeader>
              <h2 className="text-xl font-bold text-[#0D0D0D]">Phase 2 — GitHub Scan &amp; Outreach</h2>
            </CardHeader>
            <CardContent>

              {/* Scan */}
              <div className="flex items-center gap-4 mb-6">
                <Button variant="secondary" onClick={() => void handleScan()} disabled={scanning}>
                  {scanning ? 'Scanning…' : 'Scan GitHub'}
                </Button>
                {scanResult && (
                  <span className="text-sm text-[#6B7280]">
                    Found {scanResult.new} new owner{scanResult.new !== 1 ? 's' : ''}
                    {scanResult.existing > 0 && ` (${scanResult.existing} already known)`}
                  </span>
                )}
                {scanError && (
                  <span className="text-sm text-red-600">{scanError}</span>
                )}
              </div>

              {/* Discovered APIs table */}
              {discoveredApis.length > 0 ? (
                <div className="overflow-x-auto mb-6">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-[#2775CA]">
                        <th className="text-left py-2 pr-4 text-[#6B7280] font-medium">API Name</th>
                        <th className="text-left py-2 pr-4 text-[#6B7280] font-medium">GitHub Owner</th>
                        <th className="text-left py-2 pr-4 text-[#6B7280] font-medium">Email</th>
                        <th className="text-left py-2 pr-4 text-[#6B7280] font-medium">X / Twitter</th>
                        <th className="text-left py-2 text-[#6B7280] font-medium">Invited</th>
                      </tr>
                    </thead>
                    <tbody>
                      {discoveredApis.map(api => (
                        <tr key={api.id} className="border-b border-[#F0F0E8]">
                          <td className="py-2 pr-4 font-medium text-[#0D0D0D] max-w-[140px] truncate">
                            {api.api_name ?? '—'}
                          </td>
                          <td className="py-2 pr-4 text-[#6B7280]">
                            {api.owner_github ? (
                              <a
                                href={`https://github.com/${api.owner_github}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="hover:text-[#2775CA] transition-colors"
                              >
                                {api.owner_github}
                              </a>
                            ) : '—'}
                          </td>
                          <td className="py-2 pr-4 text-[#6B7280] max-w-[160px] truncate">
                            {api.owner_email ?? '—'}
                          </td>
                          <td className="py-2 pr-4 text-[#6B7280]">
                            {api.owner_x ? `@${api.owner_x}` : '—'}
                          </td>
                          <td className="py-2">{invitedBadge(api.invited)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-sm text-[#6B7280] mb-6">
                  No discovered APIs yet — click Scan GitHub to find paid API owners.
                </p>
              )}

              {/* Outreach */}
              <div className="flex items-center gap-4">
                <div title="Available at mainnet launch">
                  <Button
                    variant="accent"
                    disabled
                    onClick={() => void handleOutreach()}
                  >
                    {outreachRunning ? 'Sending…' : 'Send Outreach'}
                  </Button>
                </div>
                <span className="text-xs text-[#6B7280]">Available at mainnet launch</span>
                {outreachResult && (
                  <span className="text-sm text-[#6B7280]">
                    Sent {outreachResult.sent}, skipped {outreachResult.skipped}
                  </span>
                )}
                {outreachError && (
                  <span className="text-sm text-red-600">{outreachError}</span>
                )}
              </div>

            </CardContent>
          </Card>

        </div>
      </main>
    </>
  );
}
