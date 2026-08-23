-- Pin search_path on deduct_credits_atomic to close the Supabase
-- "Function Search Path Mutable" advisory. Body is unchanged; only
-- SET search_path = public, pg_temp is added so unqualified names
-- (credit_balances, now(), json_build_object) always resolve against
-- public first, preventing schema-shadowing hijack of the function.
--
-- CREATE OR REPLACE preserves permissions and dependencies. Signature,
-- return shape, volatility, and language are all unchanged, so the
-- caller in src/app/api/payments/credits/route.ts continues to work.

CREATE OR REPLACE FUNCTION public.deduct_credits_atomic(p_wallet text, p_amount numeric)
RETURNS json
LANGUAGE plpgsql
SET search_path = public, pg_temp
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
