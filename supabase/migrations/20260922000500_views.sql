-- Overhead: Hangar aggregation.
--
-- security_invoker = true makes the view execute with the caller's
-- privileges, so RLS on overflights, aircraft and art_assets applies and a
-- user only ever aggregates their own observations.

create view public.hangar_aircraft
with (security_invoker = true, security_barrier = true)
as
with observed as (
  select
    o.owner_id,
    o.aircraft_id,
    min(o.icao24) as icao24,
    min(o.first_seen_at) as first_seen_at,
    max(o.last_seen_at) as last_seen_at,
    count(*)::integer as pass_count,
    (count(*) filter (where o.status = 'qualified'))::integer as qualified_pass_count,
    min(o.minimum_distance_m) as closest_distance_m,
    min(o.minimum_altitude_ft) as lowest_altitude_ft,
    (array_agg(o.id order by o.minimum_distance_m asc, o.closest_seen_at asc))[1] as closest_overflight_id
  from public.overflights o
  where o.aircraft_id is not null
  group by o.owner_id, o.aircraft_id
)
select
  obs.owner_id,
  obs.aircraft_id,
  obs.icao24,
  ac.registration,
  ac.icao_type_code,
  ac.manufacturer,
  ac.model,
  ac.operator_name,
  ac.operator_icao,
  obs.first_seen_at,
  obs.last_seen_at,
  obs.pass_count,
  obs.qualified_pass_count,
  obs.closest_distance_m,
  obs.lowest_altitude_ft,
  obs.closest_overflight_id,
  art.id as best_art_asset_id,
  art.scope as best_art_scope,
  (art.id is not null) as has_artwork
from observed obs
join public.aircraft ac on ac.id = obs.aircraft_id
left join lateral (
  select aa.id, aa.scope
  from public.art_assets aa
  where aa.owner_id = obs.owner_id
    and aa.status = 'approved'
    and (
      (aa.scope = 'registration' and aa.registration = ac.registration)
      or (aa.scope in ('operator_livery', 'operator_type')
          and aa.operator_icao = ac.operator_icao and aa.icao_type_code = ac.icao_type_code)
      or (aa.scope = 'type' and aa.icao_type_code = ac.icao_type_code)
      or aa.scope = 'fallback'
    )
  order by
    case aa.scope
      when 'registration' then 1
      when 'operator_livery' then 2
      when 'operator_type' then 3
      when 'type' then 4
      else 5
    end,
    aa.approved_at desc
  limit 1
) art on true;

comment on view public.hangar_aircraft is
  'Unique aircraft observed by the calling user. security_invoker: RLS of the caller applies.';

revoke all on public.hangar_aircraft from anon, authenticated;
grant select on public.hangar_aircraft to authenticated, service_role;
