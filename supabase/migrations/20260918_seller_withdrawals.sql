-- Phase 2 architecture: seller payouts accumulate as a DB balance and are
-- minted SYNCHRONOUSLY by the PLATFORM in response to a withdrawal request.
-- The platform pays the gatewayMint gas from its own wallet and deducts the
-- estimated gas cost from the amount the seller receives. Seller signs nothing
-- and needs no Arc-mainnet gas of their own.
--
-- Column semantics on seller_withdrawals:
--   amount_usdc      = requested amount, debited from seller's earnings balance
--   net_amount_usdc  = value in the burn intent = amount actually minted to seller
--   gas_cost_usdc    = mint-tx gas the platform paid, deducted from requested amount
--                      (estimated at request time with 20% buffer; invariant:
--                       net_amount_usdc + gas_cost_usdc = amount_usdc)
--   attestation      = Circle's mint attestation for the burn intent
--   attestation_signature = Circle's signature over the attestation
--   burn_intent      = the exact struct signed and posted to /v1/transfer
--
-- Row lifecycle:
--   pending_mint  ← inserted AFTER Circle /transfer returns an attestation and
--                    BEFORE the platform submits gatewayMint. Survives a crash
--                    between attestation-fetch and mint-submit; recoverable via
--                    /api/seller/withdraw/confirm.
--   minted        ← updated after the mint tx confirms with status=success.
--   failed        ← updated after the mint tx reverts. Still consumes balance:
--                    Circle has already reserved our Gateway funds and manual
--                    ops action is required to reconcile.
--
-- purchases.seller_share_usdc stays nullable — pre-Phase-2 rows were paid out
-- on-chain via the old per-purchase GatewayClient.transfer() path and stay
-- excluded from the withdrawable_balance sum in /api/seller/earnings.
ALTER TABLE purchases
  ADD COLUMN IF NOT EXISTS seller_share_usdc numeric;

CREATE TABLE IF NOT EXISTS seller_withdrawals (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_wallet          text        NOT NULL,
  network_id             text        NOT NULL,
  amount_usdc            numeric     NOT NULL CHECK (amount_usdc > 0),
  net_amount_usdc        numeric     NOT NULL CHECK (net_amount_usdc > 0),
  gas_cost_usdc          numeric     NOT NULL CHECK (gas_cost_usdc >= 0),
  burn_intent            jsonb       NOT NULL,
  attestation            text        NOT NULL,
  attestation_signature  text        NOT NULL,
  status                 text        NOT NULL DEFAULT 'pending_mint'
                                     CHECK (status IN ('pending_mint', 'minted', 'expired', 'failed')),
  mint_tx_hash           text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  minted_at              timestamptz,
  CHECK (net_amount_usdc + gas_cost_usdc = amount_usdc)
);

CREATE INDEX IF NOT EXISTS idx_seller_withdrawals_seller ON seller_withdrawals (lower(seller_wallet));
CREATE INDEX IF NOT EXISTS idx_seller_withdrawals_status ON seller_withdrawals (status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_seller_withdrawals_mint_tx
  ON seller_withdrawals (mint_tx_hash) WHERE mint_tx_hash IS NOT NULL;

ALTER TABLE public.seller_withdrawals ENABLE ROW LEVEL SECURITY;
