-- Advan Treasury Stage 3: PostgreSQL-backed reservations and bound approvals.
-- Apply through the project's migration system. Service-role access only; never expose
-- these tables or RPCs directly to untrusted clients.

create table if not exists public.treasury_exposure_reservations (
  id uuid primary key default gen_random_uuid(),
  wallet text not null,
  intent_id text not null,
  session_id text not null,
  idempotency_key text not null,
  amount_usd numeric(20, 6) not null check (amount_usd > 0),
  utc_day date not null default (timezone('utc', now())::date),
  status text not null default 'reserved' check (status in ('reserved','committed','released')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (wallet, idempotency_key)
);
create index if not exists treasury_reservations_exposure_idx
  on public.treasury_exposure_reservations (wallet, utc_day, session_id, status);

create table if not exists public.treasury_bound_approvals (
  id uuid primary key default gen_random_uuid(),
  intent_id text not null,
  policy_id text not null,
  wallet text not null,
  intent_digest text not null check (intent_digest ~ '^[a-f0-9]{64}$'),
  transaction_message_digest text not null check (transaction_message_digest ~ '^[a-f0-9]{64}$'),
  quote_json jsonb not null,
  intent_json jsonb not null,
  reservation_id uuid not null references public.treasury_exposure_reservations(id),
  amount_usd numeric(20, 6) not null check (amount_usd > 0),
  status text not null default 'pending' check (status in ('pending','approved','rejected','consumed','expired')),
  expires_at timestamptz not null,
  decided_at timestamptz,
  decided_by text,
  decision_reason text,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists treasury_bound_approvals_pending_idx
  on public.treasury_bound_approvals (wallet, status, expires_at);

alter table public.treasury_exposure_reservations enable row level security;
alter table public.treasury_bound_approvals enable row level security;
revoke all on public.treasury_exposure_reservations from anon, authenticated;
revoke all on public.treasury_bound_approvals from anon, authenticated;
grant select, insert, update, delete on public.treasury_exposure_reservations to service_role;
grant select, insert, update, delete on public.treasury_bound_approvals to service_role;

-- Atomically reserves exposure. The advisory transaction lock serializes reservations
-- for a wallet; the idempotency constraint protects retries. Amounts are USD estimates
-- supplied by a trusted server-side pricing/risk layer, never directly from the agent.
create or replace function public.treasury_reserve_exposure(
  p_wallet text,
  p_intent_id text,
  p_session_id text,
  p_idempotency_key text,
  p_amount_usd numeric,
  p_daily_limit_usd numeric,
  p_session_limit_usd numeric default null
) returns public.treasury_exposure_reservations
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_existing public.treasury_exposure_reservations;
  v_daily numeric;
  v_session numeric;
  v_result public.treasury_exposure_reservations;
begin
  if coalesce(trim(p_wallet),'') = '' or coalesce(trim(p_intent_id),'') = ''
     or coalesce(trim(p_session_id),'') = '' or coalesce(trim(p_idempotency_key),'') = ''
     or p_amount_usd <= 0 or p_daily_limit_usd <= 0
     or (p_session_limit_usd is not null and p_session_limit_usd <= 0) then
    raise exception 'invalid reservation input' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_wallet, 0));

  select * into v_existing from public.treasury_exposure_reservations
   where wallet = p_wallet and idempotency_key = p_idempotency_key;
  if found then
    if v_existing.intent_id <> p_intent_id or v_existing.amount_usd <> p_amount_usd
       or v_existing.status = 'released' then
      raise exception 'idempotency key conflict' using errcode = '23505';
    end if;
    return v_existing;
  end if;

  select coalesce(sum(amount_usd),0) into v_daily
    from public.treasury_exposure_reservations
   where wallet = p_wallet and utc_day = timezone('utc', now())::date
     and status in ('reserved','committed');
  if v_daily + p_amount_usd > p_daily_limit_usd then
    raise exception 'daily exposure limit exceeded' using errcode = '23514';
  end if;

  if p_session_limit_usd is not null then
    select coalesce(sum(amount_usd),0) into v_session
      from public.treasury_exposure_reservations
     where wallet = p_wallet and utc_day = timezone('utc', now())::date
       and session_id = p_session_id and status in ('reserved','committed');
    if v_session + p_amount_usd > p_session_limit_usd then
      raise exception 'session exposure limit exceeded' using errcode = '23514';
    end if;
  end if;

  insert into public.treasury_exposure_reservations
    (wallet,intent_id,session_id,idempotency_key,amount_usd,utc_day)
  values (p_wallet,p_intent_id,p_session_id,p_idempotency_key,p_amount_usd,timezone('utc', now())::date)
  returning * into v_result;
  return v_result;
end;
$$;

-- Lock and consume an approved reservation exactly once. The API must first compare
-- the current canonical intent digest and transaction message digest to persisted
-- values and verify approver identity; this RPC is the final atomic state transition.
create or replace function public.treasury_consume_approval(
  p_approval_id uuid,
  p_verified_operator_id text,
  p_current_intent_digest text,
  p_current_transaction_message_digest text
) returns public.treasury_bound_approvals
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_approval public.treasury_bound_approvals;
  v_reservation public.treasury_exposure_reservations;
begin
  select * into v_approval from public.treasury_bound_approvals
   where id = p_approval_id for update;
  if not found or v_approval.status <> 'approved' then
    raise exception 'approval not approved or already consumed' using errcode = '55000';
  end if;
  if v_approval.expires_at <= now() then
    update public.treasury_bound_approvals set status='expired' where id=p_approval_id;
    update public.treasury_exposure_reservations set status='released', updated_at=now()
      where id=v_approval.reservation_id and status='reserved';
    raise exception 'approval expired' using errcode = '55000';
  end if;
  if coalesce(trim(p_verified_operator_id),'') = '' or v_approval.decided_by <> p_verified_operator_id then
    raise exception 'approver identity mismatch' using errcode = '42501';
  end if;
  if v_approval.intent_digest <> p_current_intent_digest
     or v_approval.transaction_message_digest <> p_current_transaction_message_digest then
    raise exception 'approved transaction changed' using errcode = '55000';
  end if;
  select * into v_reservation from public.treasury_exposure_reservations
   where id=v_approval.reservation_id for update;
  if not found or v_reservation.status <> 'reserved' then
    raise exception 'exposure reservation unavailable' using errcode = '55000';
  end if;
  update public.treasury_exposure_reservations set status='committed',updated_at=now()
    where id=v_reservation.id;
  update public.treasury_bound_approvals set status='consumed',consumed_at=now()
    where id=p_approval_id returning * into v_approval;
  return v_approval;
end;
$$;

revoke all on function public.treasury_reserve_exposure(text,text,text,text,numeric,numeric,numeric) from public, anon, authenticated;
revoke all on function public.treasury_consume_approval(uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.treasury_reserve_exposure(text,text,text,text,numeric,numeric,numeric) to service_role;
grant execute on function public.treasury_consume_approval(uuid,text,text,text) to service_role;
