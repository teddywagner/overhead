-- Overhead: what makes a sighting interesting, and helicopters off by default.
--
-- is_military: set by the worker from the ADS-B feed's aircraft database
-- (readsb dbFlags bit 1). Feeds only ever set it; it is never cleared.
-- operator_country: the operating airline's country, from adsbdb route
-- lookups. Compared with the location's home country to spot foreign
-- operators (see aircraftHighlights in @overhead/core).

alter table public.aircraft
  add column is_military boolean not null default false,
  add column operator_country text
    check (operator_country is null or char_length(btrim(operator_country)) between 1 and 80);

-- Frames no longer show helicopters unless asked to. Saved settings carried
-- the old default along, so they are switched off too.
alter table public.device_display_settings alter column include_helicopters set default false;
update public.device_display_settings set include_helicopters = false where include_helicopters;
