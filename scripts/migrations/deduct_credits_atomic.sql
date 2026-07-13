-- Run in Supabase SQL editor (or psql) before deploying the C1 credit-deduction fix.
-- Atomically subtracts credits in a single UPDATE statement, preventing the
-- read-check-write race condition that allows double-spending.
CREATE OR REPLACE FUNCTION deduct_credits_atomic(p_wallet text, p_amount numeric)
RETURNS json
LANGUAGE plpgsql
AS $$
DECLARE
  v_new_balance  numeric;
  v_curr_balance numeric;
BEGIN
  UPDATE credit_balances
  SET    balance_usdc = balance_usdc - p_amount,
         updated_at   = now()
  WHERE  buyer_wallet = p_wallet
    AND  balance_usdc >= p_amount
  RETURNING balance_usdc INTO v_new_balance;

  IF FOUND THEN
    RETURN json_build_object('ok', true, 'balance_usdc', v_new_balance);
  END IF;

  -- Deduction failed — return current balance so the caller can surface it
  SELECT balance_usdc INTO v_curr_balance
  FROM   credit_balances
  WHERE  buyer_wallet = p_wallet;

  RETURN json_build_object('ok', false, 'balance_usdc', COALESCE(v_curr_balance, 0));
END;
$$;
