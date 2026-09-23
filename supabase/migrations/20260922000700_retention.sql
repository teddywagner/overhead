-- Overhead: bounded retention for sampled points and operational records.
--
-- Called by the worker every RETENTION_INTERVAL_MINUTES (see docs/worker.md);
-- can also be scheduled with pg_cron. SECURITY INVOKER, private schema, not
-- executable by any Data API role.

create or replace function private.apply_retention(
  overflight_point_days integer default 365,
  device_log_days integer default 30,
  device_log_max_per_device integer default 500,
  poll_run_days integer default 14,
  worker_error_days integer default 30,
  enrichment_days integer default 90
)
returns table (table_name text, deleted_count bigint)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  n bigint;
  n2 bigint;
begin
  delete from public.overflight_points
   where created_at < now() - make_interval(days => overflight_point_days);
  get diagnostics n = row_count;
  table_name := 'overflight_points'; deleted_count := n; return next;

  delete from private.device_logs
   where received_at < now() - make_interval(days => device_log_days);
  get diagnostics n = row_count;
  delete from private.device_logs dl
   using (
     select id from (
       select id, row_number() over (partition by device_id order by received_at desc, id desc) as rn
       from private.device_logs
     ) ranked
     where ranked.rn > device_log_max_per_device
   ) excess
   where dl.id = excess.id;
  get diagnostics n2 = row_count;
  table_name := 'device_logs'; deleted_count := n + n2; return next;

  delete from private.provider_poll_runs
   where started_at < now() - make_interval(days => poll_run_days);
  get diagnostics n = row_count;
  table_name := 'provider_poll_runs'; deleted_count := n; return next;

  delete from private.worker_errors
   where occurred_at < now() - make_interval(days => worker_error_days);
  get diagnostics n = row_count;
  table_name := 'worker_errors'; deleted_count := n; return next;

  delete from private.enrichment_attempts
   where attempted_at < now() - make_interval(days => enrichment_days);
  get diagnostics n = row_count;
  table_name := 'enrichment_attempts'; deleted_count := n; return next;
end;
$$;

revoke all on function private.apply_retention(integer, integer, integer, integer, integer, integer)
  from public, anon, authenticated, service_role;
