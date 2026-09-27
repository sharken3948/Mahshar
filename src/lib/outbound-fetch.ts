import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

const MAX_PORT = 443;

export class OutboundPolicyError extends Error {
  constructor(readonly classification: 'invalid_url' | 'blocked_destination' | 'dns_failure' | 'blocked_port' | 'timeout' | 'redirect' | 'response_too_large') {
    super(classification);
    this.name = 'OutboundPolicyError';
  }
}

export type ResolvedAddress = { address: string; family: 4 | 6 };
export type OutboundResolver = (hostname: string) => Promise<ResolvedAddress[]>;
export type PreparedOutboundRequest = { url: URL; outboundInit: RequestInit };
type InitFactory = RequestInit | ((validatedUrl: URL) => RequestInit | PreparedOutboundRequest | Promise<RequestInit | PreparedOutboundRequest>);
export type OutboundOptions = {
  timeoutMs?: number;
  resolver?: OutboundResolver;
  /** Test seam for deterministic transport-boundary verification; production uses pinnedRequest. */
  requester?: (url: URL, address: ResolvedAddress, init: RequestInit, timeoutMs: number) => Promise<Response>;
};

const IPV4_DENY: Array<[string, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4],
];

function ipv4Number(ip: string): number | null {
  if (isIP(ip) !== 4) return null;
  return ip.split('.').reduce((n, octet) => ((n << 8) | Number(octet)) >>> 0, 0);
}

function inV4Cidr(ip: string, network: string, bits: number): boolean {
  const value = ipv4Number(ip);
  const base = ipv4Number(network);
  if (value === null || base === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (base & mask);
}

function ipv6Words(ip: string): number[] | null {
  if (isIP(ip) !== 6 || ip.includes('%')) return null;
  let normalized = ip.toLowerCase();
  let embeddedV4: string | undefined;
  const lastColon = normalized.lastIndexOf(':');
  const dotted = normalized.slice(lastColon + 1);
  if (dotted.includes('.')) {
    const n = ipv4Number(dotted);
    if (n === null) return null;
    embeddedV4 = `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
    normalized = normalized.slice(0, lastColon + 1) + embeddedV4;
  }
  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const words = [...left, ...Array(missing).fill('0'), ...right].map(part => Number.parseInt(part, 16));
  return words.length === 8 && words.every(n => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? words : null;
}

function ipv6Prefix(words: number[], prefix: number[], bits: number): boolean {
  const full = Math.floor(bits / 16);
  const remaining = bits % 16;
  for (let i = 0; i < full; i++) if (words[i] !== prefix[i]) return false;
  if (remaining && ((words[full] >>> (16 - remaining)) !== (prefix[full] >>> (16 - remaining)))) return false;
  return true;
}

function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    // Only globally routable unicast is eligible. This also rejects this-host,
    // benchmarking, documentation, multicast, reserved, and broadcast space.
    return IPV4_DENY.some(([network, bits]) => inV4Cidr(ip, network, bits)) ||
      Number(ip.split('.')[0]) >= 240;
  }
  if (family !== 6) return true;
  const words = ipv6Words(ip);
  if (!words) return true;
  // IPv4-mapped IPv6 addresses inherit the IPv4 destination policy.
  if (words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff) {
    const mappedV4 = `${words[6] >>> 8}.${words[6] & 255}.${words[7] >>> 8}.${words[7] & 255}`;
    return isBlockedAddress(mappedV4);
  }
  // Permit only global-unicast allocation 2000::/3, excluding protocol,
  // documentation, transition, and benchmarking ranges.
  if (!ipv6Prefix(words, [0x2000], 3)) return true;
  return ipv6Prefix(words, [0x2000], 16) || // protocol-assignment space
    ipv6Prefix(words, [0x2001, 0], 23) || // IETF special-purpose block
    ipv6Prefix(words, [0x2001, 0x0db8], 32) ||
    ipv6Prefix(words, [0x3fff], 20) ||
    ipv6Prefix(words, [0x2002], 16); // 6to4 embeds a second destination
}

function normalizeAndCheckUrl(input: string | URL): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new OutboundPolicyError('invalid_url'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new OutboundPolicyError('invalid_url');
  if (url.port && url.port !== String(MAX_PORT)) throw new OutboundPolicyError('blocked_port');
  url.hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!hostname || (!isIP(hostname) && !hostname.includes('.')) || hostname === 'localhost' || ['.localhost', '.local', '.internal', '.home.arpa', '.onion'].some(suffix => hostname.endsWith(suffix))) {
    throw new OutboundPolicyError('blocked_destination');
  }
  return url;
}

export function isOutboundUrlShapeAllowed(input: string): boolean {
  try {
    const url = normalizeAndCheckUrl(input);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    return !isIP(host) || !isBlockedAddress(host);
  } catch { return false; }
}

async function resolveAll(hostname: string): Promise<ResolvedAddress[]> {
  const family = isIP(hostname);
  if (family) return [{ address: hostname, family: family as 4 | 6 }];
  try {
    const records = await lookup(hostname, { all: true, verbatim: true });
    return records.map(record => ({ address: record.address, family: record.family as 4 | 6 }));
  } catch {
    throw new OutboundPolicyError('dns_failure');
  }
}

function toNodeHeaders(headers: HeadersInit | undefined): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  new Headers(headers).forEach((value, key) => { result[key] = value; });
  return result;
}

function bodyBuffer(body: BodyInit | null | undefined): Buffer | undefined {
  if (body == null) return undefined;
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  throw new TypeError('Unsupported outbound request body');
}

function toWebResponse(response: IncomingMessage): Response {
  const headers = new Headers();
  for (const [key, value] of Object.entries(response.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(key, item);
    else if (value !== undefined) headers.set(key, value);
  }
  let responseStream: Readable = response;
  const encodings = (response.headers['content-encoding'] ?? '').split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
  if (encodings.length) {
    for (const encoding of encodings.reverse()) {
      if (encoding === 'gzip' || encoding === 'x-gzip') responseStream = responseStream.pipe(createGunzip());
      else if (encoding === 'deflate') responseStream = responseStream.pipe(createInflate());
      else if (encoding === 'br') responseStream = responseStream.pipe(createBrotliDecompress());
      else if (encoding !== 'identity') throw new Error('Unsupported upstream content encoding');
    }
    headers.delete('content-encoding');
    headers.delete('content-length');
  }
  headers.delete('transfer-encoding');
  const body = response.statusCode === 204 || response.statusCode === 205 || response.statusCode === 304
    ? null
    : Readable.toWeb(responseStream) as ReadableStream<Uint8Array>;
  return new Response(body, { status: response.statusCode ?? 502, statusText: response.statusMessage, headers });
}

async function pinnedRequest(url: URL, address: ResolvedAddress, init: RequestInit, timeoutMs: number): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase();
  const body = bodyBuffer(init.body);
  const headers = toNodeHeaders(init.headers);
  if (body && !Object.keys(headers).some(name => name.toLowerCase() === 'content-length')) headers['content-length'] = String(body.byteLength);
  if (!Object.keys(headers).some(name => name.toLowerCase() === 'accept-encoding')) headers['accept-encoding'] = 'gzip, deflate, br';
  const options: RequestOptions = {
    ...createPinnedRequestOptions(url, address), method, headers,
  };
  return new Promise((resolve, reject) => {
    let responseReceived = false;
    const req = httpsRequest(options, response => {
      responseReceived = true;
      response.once('end', cleanup);
      response.once('close', cleanup);
      try { resolve(toWebResponse(response)); }
      catch (error) { response.destroy(); reject(error); }
    });
    const timer = setTimeout(() => req.destroy(new OutboundPolicyError('timeout')), timeoutMs);
    const signal = init.signal;
    const onAbort = () => req.destroy(signal?.reason instanceof Error ? signal.reason : new OutboundPolicyError('timeout'));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
    req.once('error', error => reject(error));
    req.once('close', () => { if (!responseReceived) cleanup(); });
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Server-only fetch for user-controlled endpoints. Resolves all answers directly
 * before request construction, rejects mixed public/private DNS, then pins the
 * HTTPS socket lookup to one already-approved answer. Redirects are always manual.
 */
export async function safeOutboundFetch(
  input: string | URL,
  initOrFactory: InitFactory = {},
  options: OutboundOptions = {},
): Promise<Response> {
  const url = normalizeAndCheckUrl(input);
  const resolver = options.resolver ?? resolveAll;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const startedAt = Date.now();
  let addresses: ResolvedAddress[];
  let resolutionTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    addresses = await Promise.race([
      resolver(url.hostname.replace(/^\[|\]$/g, '')),
      new Promise<never>((_, reject) => {
        resolutionTimer = setTimeout(() => reject(new OutboundPolicyError('timeout')), timeoutMs);
      }),
    ]);
  }
  catch (error) {
    if (error instanceof OutboundPolicyError) throw error;
    throw new OutboundPolicyError('dns_failure');
  } finally {
    if (resolutionTimer) clearTimeout(resolutionTimer);
  }
  if (!addresses.length || addresses.some(item => isBlockedAddress(item.address))) {
    throw new OutboundPolicyError('blocked_destination');
  }
  const chosen = addresses[0];
  const prepared = typeof initOrFactory === 'function' ? await initOrFactory(new URL(url)) : initOrFactory;
  let requestUrl = url;
  let init: RequestInit;
  if ('outboundInit' in prepared) {
    requestUrl = normalizeAndCheckUrl(prepared.url);
    if (requestUrl.origin !== url.origin) throw new OutboundPolicyError('blocked_destination');
    init = prepared.outboundInit;
  } else {
    init = prepared;
  }
  if (init.signal?.aborted) throw new OutboundPolicyError('timeout');
  const remainingMs = timeoutMs - (Date.now() - startedAt);
  if (remainingMs <= 0) throw new OutboundPolicyError('timeout');
  try {
    return await (options.requester ?? pinnedRequest)(requestUrl, chosen, init, remainingMs);
  } catch (error) {
    if (error instanceof OutboundPolicyError) throw error;
    if (init.signal?.aborted) throw new OutboundPolicyError('timeout');
    throw error;
  }
}

export async function validateEndpointUrl(url: string): Promise<{ valid: boolean; error?: string }> {
  try {
    const parsed = normalizeAndCheckUrl(url);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const addresses = await Promise.race([
      resolveAll(parsed.hostname.replace(/^\[|\]$/g, '')),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new OutboundPolicyError('timeout')), 5_000); }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
    if (!addresses.length || addresses.some(item => isBlockedAddress(item.address))) {
      return { valid: false, error: 'Endpoint resolves to a prohibited address' };
    }
    return { valid: true };
  } catch (error) {
    if (error instanceof OutboundPolicyError && error.classification === 'blocked_port') return { valid: false, error: 'Only HTTPS port 443 is allowed' };
    if (error instanceof OutboundPolicyError && error.classification === 'dns_failure') return { valid: false, error: 'Could not resolve hostname' };
    return { valid: false, error: 'Invalid or prohibited endpoint URL' };
  }
}

export function isProhibitedOutboundAddress(address: string): boolean {
  return isBlockedAddress(address);
}

export function createPinnedRequestOptions(url: URL, address: ResolvedAddress): RequestOptions {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  return {
    protocol: 'https:', hostname, port: MAX_PORT, family: address.family, agent: false,
    path: `${url.pathname}${url.search}`,
    ...(isIP(hostname) === 0 ? { servername: hostname } : {}), rejectUnauthorized: true,
    lookup: ((_hostname: string, optionsOrCallback: unknown, callbackMaybe?: (...args: unknown[]) => void) => {
      const callback = (typeof optionsOrCallback === 'function' ? optionsOrCallback : callbackMaybe) as ((...args: unknown[]) => void) | undefined;
      if (!callback) throw new Error('Missing socket lookup callback');
      if (typeof optionsOrCallback !== 'function' && optionsOrCallback && (optionsOrCallback as { all?: boolean }).all) {
        callback(null, [{ address: address.address, family: address.family }]);
      } else {
        callback(null, address.address, address.family);
      }
    }) as RequestOptions['lookup'],
  };
}
