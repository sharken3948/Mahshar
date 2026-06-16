import type { X402PaymentRequired } from '@/types';

export interface PaymentPayload {
  scheme: string;
  network: string;
  payload: {
    signature: string;
    authorization: {
      from: string;
      to: string;
      value: string;
      validAfter: string;
      validBefore: string;
      nonce: string;
    };
  };
}

/**
 * Parse the x-payment-required header returned with a 402 response.
 */
export function parsePaymentRequired(header: string): X402PaymentRequired {
  return JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as X402PaymentRequired;
}

/**
 * Build the x-payment header to attach to a retried request.
 * In production this would sign a EIP-3009 transferWithAuthorization tx.
 * The signature and authorization fields must be populated by the wallet layer.
 */
export function buildPaymentHeader(
  paymentRequired: X402PaymentRequired,
  fromAddress: string,
  signature: string,
  nonce: string
): string {
  const validAfter = Math.floor(Date.now() / 1000).toString();
  const validBefore = (Math.floor(Date.now() / 1000) + paymentRequired.maxTimeoutSeconds).toString();

  const payload: PaymentPayload = {
    scheme: paymentRequired.scheme,
    network: paymentRequired.network,
    payload: {
      signature,
      authorization: {
        from: fromAddress,
        to: paymentRequired.payTo,
        value: paymentRequired.maxAmountRequired,
        validAfter,
        validBefore,
        nonce,
      },
    },
  };

  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

/**
 * Handle a 402 response from an upstream API.
 * Returns the parsed payment requirement so the caller can construct payment.
 */
export async function handle402(response: Response): Promise<X402PaymentRequired | null> {
  if (response.status !== 402) return null;
  const header = response.headers.get('x-payment-required');
  if (!header) return null;
  try {
    return parsePaymentRequired(header);
  } catch {
    return null;
  }
}

/**
 * Retry a request with the x-payment header attached.
 */
export async function retryWithPayment(
  url: string,
  init: RequestInit,
  paymentHeader: string
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('x-payment', paymentHeader);
  return fetch(url, { ...init, headers });
}
