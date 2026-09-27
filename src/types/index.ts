export type PaymentModel = 'pay-per-call';
export type AuthType = 'public' | 'apikey' | 'bearer' | 'queryparam';

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
  auth_param_name: string | null;
  endpoint_url: string;
  method: string | null;
  example_request: string | null;
  example_response: string | null;
  score: number | null;
  uptime: number | null;
  created_at: string;
  is_active: boolean;
  verified_at: string | null;
  expected_status_codes: number[] | null;
  request_schema?: Record<string, unknown> | null;
  response_schema?: Record<string, unknown> | null;
  body_required?: boolean | null;
  dynamic_path_supported?: boolean;
  path_parameters?: unknown[] | null;
  query_parameters?: unknown[] | null;
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
  is_client_error: boolean | null;
  is_declared_expected: boolean | null;
  created_at: string;
}
