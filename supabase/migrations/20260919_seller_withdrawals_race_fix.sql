ALTER TABLE seller_withdrawals ALTER COLUMN attestation DROP NOT NULL;
ALTER TABLE seller_withdrawals ALTER COLUMN attestation_signature DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_seller_withdrawals_pending_mint ON seller_withdrawals (lower(seller_wallet)) WHERE status = 'pending_mint';
