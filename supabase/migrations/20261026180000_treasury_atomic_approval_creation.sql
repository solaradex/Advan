-- Atomically create a quote-bound approval only against its active matching reservation.
-- This closes the gap between reservation validation and approval insertion.
create or replace function public.treasury_create_bound_approval(
  p_intent_id text,
  p_policy_id text,
  p_wallet text,
  p_intent_digest text,
  p_transaction_message_digest text,
  p_quote_json jsonb,
  p_intent_json jsonb,
  p_reservation_id uuid,
  p_amount_usd numeric,
  p_expires_at timestamptz
) returns public.treasury_bound_approvals
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_reservation public.treasury_exposure_reservations;
  v_approval public.treasury_bound_approvals;
begin
  if coalesce(trim(p_intent_id),'') = '' or coalesce(trim(p_policy_id),'') = ''
     or coalesce(trim(p_wallet),'') = '' or p_intent_digest !~ '^[a-f0-9]{64}$'
     or p_transaction_message_digest !~ '^[a-f0-9]{64}$'
     or p_amount_usd <= 0 or p_expires_at <= now()
     or p_expires_at > now() + interval '30 minutes' then
    raise exception 'invalid bound approval input' using errcode = '22023';
  end if;

  select * into v_reservation from public.treasury_exposure_reservations
   where id = p_reservation_id for update;
  if not found or v_reservation.status <> 'reserved'
     or v_reservation.intent_id <> p_intent_id
     or v_reservation.wallet <> p_wallet
     or v_reservation.amount_usd <> p_amount_usd then
    raise exception 'active matching exposure reservation required' using errcode = '55000';
  end if;

  insert into public.treasury_bound_approvals
    (intent_id,policy_id,wallet,intent_digest,transaction_message_digest,quote_json,
     intent_json,reservation_id,amount_usd,expires_at,status)
  values
    (p_intent_id,p_policy_id,p_wallet,p_intent_digest,p_transaction_message_digest,
     p_quote_json,p_intent_json,p_reservation_id,p_amount_usd,p_expires_at,'pending')
  returning * into v_approval;
  return v_approval;
end;
$$;

revoke all on function public.treasury_create_bound_approval(text,text,text,text,text,jsonb,jsonb,uuid,numeric,timestamptz) from public, anon, authenticated;
grant execute on function public.treasury_create_bound_approval(text,text,text,text,text,jsonb,jsonb,uuid,numeric,timestamptz) to service_role;
