-- tx_hash double-spend protection: enforce uniqueness so a replayed settled
-- payload cannot insert a second purchases row for the same on-chain settlement.
create unique index if not exists idx_purchases_tx_hash on purchases(tx_hash);

-- Set ioscope price to $0.001/call.
update api_listings
   set price_per_call = 0.001
 where id = '34c7a931-81de-4b8b-81ac-0916b4316989';
