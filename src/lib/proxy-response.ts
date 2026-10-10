import { safeOutboundFetch, type OutboundOptions, type PreparedOutboundRequest } from '@/lib/outbound-fetch';

export const MAX_UPSTREAM_DIAGNOSTIC_BODY_CHARS = 4096;
export const MAX_SAFE_SERIALIZED_RESPONSE_BYTES = 4_000_000;
export const VERIFICATION_RESPONSE_WARNING_BYTES = 3_500_000;
const REPRESENTATIVE_DELIVERY_OVERHEAD_BYTES = 2_048;

export function serializedJsonByteLength(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

export function assessRepresentativeResponseSize(body: unknown) {
  // The live delivery adds payment state, attempt identity and a recovery token.
  // Reserve fixed conservative headroom so verification never approves a sample
  // that only fits when those required fields are omitted.
  const serializedBytes = serializedJsonByteLength(body) + REPRESENTATIVE_DELIVERY_OVERHEAD_BYTES;
  return {
    serializedBytes,
    warning: serializedBytes >= VERIFICATION_RESPONSE_WARNING_BYTES,
    exceedsLimit: serializedBytes > MAX_SAFE_SERIALIZED_RESPONSE_BYTES,
  };
}

export function buildUpstreamFailureDiagnostic(status: number, contentType: string, rawBody: string) {
  return {
    upstream_status: status,
    upstream_content_type: contentType || null,
    upstream_body: rawBody.slice(0, MAX_UPSTREAM_DIAGNOSTIC_BODY_CHARS),
    upstream_body_truncated: rawBody.length > MAX_UPSTREAM_DIAGNOSTIC_BODY_CHARS,
  };
}

type SupportedCredentialAuth = 'apikey' | 'bearer' | 'queryparam';

function encodedCredentialVariants(credential: string) {
  const variants = new Set([credential]);
  try {
    variants.add(encodeURIComponent(credential));
  } catch {
    // A malformed Unicode credential cannot be encoded this way by the request builder either.
  }
  const formEncoded = new URLSearchParams([['credential', credential]]).toString().slice('credential='.length);
  variants.add(formEncoded);
  for (const value of [...variants]) variants.add(value.replace(/%[0-9A-F]{2}/g, match => match.toLowerCase()));
  return [...variants].filter(Boolean);
}

function parsedJsonContainsCredential(value: unknown, variants: readonly string[]) {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === 'string') {
      if (variants.some(variant => current.includes(variant))) return true;
      continue;
    }
    if (!current || typeof current !== 'object') continue;
    if (Array.isArray(current)) pending.push(...current);
    else {
      for (const [key, nested] of Object.entries(current)) {
        if (variants.some(variant => key.includes(variant))) return true;
        pending.push(nested);
      }
    }
  }
  return false;
}

export function containsReflectedUpstreamCredential(input: {
  authType: SupportedCredentialAuth;
  credential: string;
  rawBody: string;
  parsedBody: unknown;
}) {
  if (!input.credential) return false;
  const variants = input.authType === 'queryparam'
    ? encodedCredentialVariants(input.credential)
    : [input.credential];
  if (input.authType === 'bearer') variants.push(`Bearer ${input.credential}`);
  return variants.some(variant => input.rawBody.includes(variant)) ||
    parsedJsonContainsCredential(input.parsedBody, variants);
}

export class ResponseTooLargeError extends Error {
  constructor() {
    super('Upstream response exceeds the configured size limit');
    this.name = 'ResponseTooLargeError';
  }
}

export function fetchUpstreamWithoutRedirects(
  input: string | URL,
  init: RequestInit | ((validatedUrl: URL) => RequestInit | PreparedOutboundRequest | Promise<RequestInit | PreparedOutboundRequest>),
  options?: OutboundOptions,
): Promise<Response> {
  const factory = typeof init === 'function'
    ? async (url: URL) => {
      const prepared = await init(url);
      if ('outboundInit' in prepared) return { ...prepared, outboundInit: { ...prepared.outboundInit, redirect: 'manual' as const } };
      return { ...prepared, redirect: 'manual' as const };
    }
    : { ...init, redirect: 'manual' as const };
  return safeOutboundFetch(input, factory, options);
}

export async function readResponseBytes(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!stream) return new Uint8Array();

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // The size limit remains the governing failure even if cancellation fails.
        }
        throw new ResponseTooLargeError();
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
