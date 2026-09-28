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
