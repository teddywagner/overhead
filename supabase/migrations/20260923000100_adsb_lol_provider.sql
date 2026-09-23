-- Overhead: add adsb.lol as an aircraft position provider.
--
-- Airplanes.live closed its public API to non-feeders (~August 2026); the
-- worker now defaults to adsb.lol, which serves the same readsb v2 format.
-- Existing rows are unaffected: the allowed set only grows.

alter table public.overflights drop constraint if exists overflights_provider_check;
alter table public.overflights add constraint overflights_provider_check
  check (provider in ('adsb_lol', 'airplanes_live', 'mock'));

alter table private.active_passes drop constraint if exists active_passes_provider_check;
alter table private.active_passes add constraint active_passes_provider_check
  check (provider in ('adsb_lol', 'airplanes_live', 'mock'));
