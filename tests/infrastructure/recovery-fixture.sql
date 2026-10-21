-- Synthetic offline history only. Never run on Production.
INSERT INTO api_listings(id,name,description,category,price_per_call,payment_model,seller_wallet,auth_type,endpoint_url)
          VALUES('00000000-0000-4000-8000-000000000001','Fixture','Fixture','test',0.001,'pay-per-call','0x2222222222222222222222222222222222222222','public','https://fixture.invalid');
          INSERT INTO x402_settlement_attempts(id,fingerprint,authorization_key,api_id,binding,created_at,updated_at)
          VALUES('00000000-0000-4000-8000-000000000002',repeat('a',64),repeat('b',64),'00000000-0000-4000-8000-000000000001','{}',now()-interval '90 days',now()-interval '90 days');
          INSERT INTO purchases(id,buyer_wallet,api_id,amount_usdc,tx_hash,created_at)
          VALUES('00000000-0000-4000-8000-000000000003','0x1111111111111111111111111111111111111111','00000000-0000-4000-8000-000000000001',0.001,'offline-fixture',now()-interval '90 days');
          INSERT INTO api_calls(api_id,buyer_wallet,payment_type,latency_ms,success,purchase_id,delivery_attempt_id,response_body,response_expires_at,created_at)
          VALUES('00000000-0000-4000-8000-000000000001','0x1111111111111111111111111111111111111111','pay-per-call',1,true,'00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000002','{"fixture":"recovery"}',now()-interval '80 days',now()-interval '90 days');
          INSERT INTO withdraw_used_nonces(nonce,seller_wallet,created_at)
          VALUES('offline-replay-fixture','0x2222222222222222222222222222222222222222',now()-interval '90 days');
          INSERT INTO seller_withdrawals(seller_wallet,network_id,amount_usdc,net_amount_usdc,gas_cost_usdc,burn_intent,status,created_at)
          VALUES('0x2222222222222222222222222222222222222222','eip155:5042',1,1,0,'{}','pending_mint',now()-interval '90 days');
