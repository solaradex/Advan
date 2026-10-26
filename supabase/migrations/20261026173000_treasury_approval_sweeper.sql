-- Atomic approval decisions and expiry cleanup for Advan Treasury.
create or replace function public.treasury_decide_approval(
  p_approval_id uuid,
  p_status text,
  p_verified_operator_id text,
  p_reason text default null
) returns public.treasury_bound_approvals
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_approval public.treasury_bound_approvals;
  v_final_status text;
begin
  if p_status not in ('approved','rejected') or coalesce(trim(p_verified_operator_id),'') = '' then
    raise exception 'invalid decision input' using errcode = '22023';
  end if;
  select * into v_approval from public.treasury_bound_approvals
   where id = p_approval_id for update;
  if not found or v_approval.status <> 'pending' then
    raise exception 'approval missing or already decided' using errcode = '55000';
  end if;
  v_final_status := case when v_approval.expires_at <= now() then 'expired' else p_status end;
  update public.treasury_bound_approvals
     set status = v_final_status,
         decided_at = now(),
         decided_by = case when v_final_status = 'expired' then null else p_verified_operator_id end,
         decision_reason = case when v_final_status = 'expired' then 'expired' else p_reason end
   where id = p_approval_id returning * into v_approval;
  if v_final_status in ('rejected','expired') then
    update public.treasury_exposure_reservations set status='released', updated_at=now()
     where id=v_approval.reservation_id and status='reserved';
  end if;
  return v_approval;
end;
$$;

-- Batch sweeper: update rows without raising, so expiry and release commit together.
create or replace function public.treasury_expire_pending(p_batch_size integer default 200)
returns integer
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_count integer;
begin
  if p_batch_size < 1 or p_batch_size > 2000 then
    raise exception 'invalid batch size' using errcode = '22023';
  end if;
  with expired as (
    select id, reservation_id from public.treasury_bound_approvals
     where status='pending' and expires_at <= now()
     order by expires_at
     for update skip locked limit p_batch_size
  ), changed as (
    update public.treasury_bound_approvals a
       set status='expired', decision_reason='expired'
      from expired e where a.id=e.id returning a.reservation_id
  )
  update public.treasury_exposure_reservations r
     set status='released', updated_at=now()
    where r.id in (select reservation_id from changed) and r.status='reserved';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.treasury_decide_approval(uuid,text,text,text) from public, anon, authenticated;
revoke all on function public.treasury_expire_pending(integer) from public, anon, authenticated;
grant execute on function public.treasury_decide_approval(uuid,text,text,text) to service_role;
grant execute on function public.treasury_expire_pending(integer) to service_role;
