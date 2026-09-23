-- Overhead: track what each enrichment attempt looked up.
--
-- 'observation' rows are written by the worker when it first sees an
-- aircraft; 'aircraft' and 'route' rows record adsbdb lookups so each
-- aircraft / overflight is looked up once (and retried after errors).

alter table private.enrichment_attempts
  add column kind text not null default 'observation'
    check (kind in ('observation', 'aircraft', 'route')),
  add column overflight_id uuid references public.overflights (id) on delete cascade;

create index enrichment_attempts_lookup_idx
  on private.enrichment_attempts (provider, kind, aircraft_id, attempted_at desc);
create index enrichment_attempts_overflight_idx
  on private.enrichment_attempts (overflight_id, attempted_at desc)
  where overflight_id is not null;
