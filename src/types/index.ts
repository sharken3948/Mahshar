export type PaymentModel = 'pay-per-call' | 'credits' | 'both';
export type AuthType = 'public' | 'apikey' | 'bearer';

export interface ApiListing {
  id: string;
  name: string;
  description: string;
  category: string;
  price_per_call: number;
  payment_model: PaymentModel;
  seller_wallet: string;
  auth_type: AuthType;
  encrypted_key: string | null;
  endpoint_url: string;
  example_request: string | null;
  example_response: string | null;
  score: number | null;
  uptime: number | null;
  created_at: string;
  is_active: boolean;
}

export interface Purchase {
  id: string;
  buyer_wallet: string;
  api_id: string;
  amount_usdc: number;
  tx_hash: string;
  created_at: string;
}

export interface CreditBalance {
  id: string;
  buyer_wallet: string;
  balance_usdc: number;
  updated_at: string;
}

export interface ApiCall {
  id: string;
  api_id: string;
  buyer_wallet: string;
  payment_type: PaymentModel;
  latency_ms: number;
  success: boolean;
  created_at: string;
}

export interface X402PaymentRequired {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra?: Record<string, unknown>;
}

export interface ProxyRequest {
  api_id: string;
  buyer_wallet: string;
  payment_type: PaymentModel;
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: unknown;
}
