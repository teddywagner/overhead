# Polling worker

`apps/worker` is a long-running Bun process:

```bash
bun run dev:worker                 # watch mode
bun run start:worker            # after `bun run build`
```

## Loop

Every `WORKER_POLL_INTERVAL_SECONDS` (default 15) the `Poller`:

1. loads active locations (`public.locations where is_active`);
2. for each location not in backoff, asks the provider for aircraft within
   `search_radius_nm` plus a margin (`max(1 NM, 20 %)`). Providers only return
   aircraft inside the queried circle, so the margin is what lets the worker
   see an aircraft leave the search radius and finalise the pass immediately
   instead of waiting for the gap timeout;
3. loads that location's `private.active_passes`;
4. runs the pure state machine `processTick`;
5. persists the result in **one transaction** (`PostgresWorkerStore.applyTick`);
6. writes a `private.provider_poll_runs` row;
7. every `RETENTION_INTERVAL_MINUTES`, calls `private.apply_retention()`.

Coordinates are only ever sent to the provider; they are never logged. Error
messages stored in `private.worker_errors` are scrubbed of URLs and decimal
coordinates.

### Failures and backoff

- Provider requests have a 10 s timeout, a descriptive `User-Agent`
  (`AIRCRAFT_PROVIDER_USER_AGENT`, required) and are serialised with ≥1.1 s
  spacing (public ADS-B APIs allow roughly one request per second).
- A failing location backs off exponentially: 15 s × 2ⁿ⁻¹, capped at 15 min,
  plus up to 20 % jitter. Other locations keep polling.
- HTTP 429 honours `Retry-After` and pauses **all** locations (shared quota).
- HTTP 401/403 (`access_denied`, e.g. a service turning feeder-only) pauses
  all locations for the maximum backoff (15 min) instead of retrying each poll.
- A failed transaction leaves the previous state intact; the next tick
  recomputes from what was persisted.

## Providers

```ts
interface AircraftPositionProvider {
  readonly name: 'adsb_lol' | 'airplanes_live' | 'mock';
  getAircraftNear(input: {
    latitude: number;
    longitude: number;
    radiusNm: number;
  }): Promise<NormalizedAircraftPosition[]>;
}
```

- **adsb.lol** (default, `AIRCRAFT_PROVIDER=adsb_lol`) and **Airplanes.live**
  (`airplanes_live`, feeders only since ~August 2026) share one readsb v2
  client (`providers/readsb-v2.ts`) for `GET /v2/point/{lat}/{lon}/{radius}`:
  responses are validated with Zod; invalid entries are skipped;
  `alt_baro: "ground"` marks ground traffic; the measurement time is
  `now − seen_pos`; empty strings become `null`. Fixture:
  `packages/flight-tracking/test/fixtures/readsb-v2-point.json`.
- **Mock** (`AIRCRAFT_PROVIDER=mock`, `MOCK_SCENARIO`): deterministic tracks
  generated relative to the queried point (`direct-crossing`, `near-miss`,
  `busy`), replayed every 15 minutes.
- **Scripted** (tests): replays hand-built frames to exercise edge cases.

Adding a provider means implementing the interface and a Zod parser in
`packages/flight-tracking/src/providers/`, then wiring it in
`apps/worker/src/index.ts`.

## Overflight detection

`processTick({ location, provider, now, positions, active })` is pure and
returns `{ upserts, finalized, started, rejected }`.

**Sample validation** — rejected samples never start or extend a pass:

| reason                       | rule                                                      |
| ---------------------------- | --------------------------------------------------------- |
| `on_ground`                  | provider reports ground                                   |
| `taxiing_or_stationary`      | ground speed < 40 kt and altitude < 1,000 ft (or unknown) |
| `stale`                      | measured > 60 s before the poll                           |
| `future_timestamp`           | measured > 10 s after the poll                            |
| `implausible_altitude`       | outside −1,500 … 70,000 ft                                |
| `implausible_jump`           | implied speed from the previous sample > 1,000 kt         |
| `out_of_order` / `duplicate` | not newer than the pass's current sample                  |

**Pass lifecycle**

1. _Start_ — first valid sample inside the search radius. The provider pass
   key is `"{provider}:{icao24}:{unix seconds of that sample}"`, which is
   deterministic and survives restarts.
2. _Continue_ — each newer sample extends the pass while the gap since the
   last accepted sample is ≤ `PASS_GAP_TIMEOUT_SECONDS` (300 s).
3. _Closest approach_ — for every consecutive pair of samples (≤ 120 s apart)
   the geodesic **point-to-segment** distance from the location to the
   great-circle segment is computed (cross-track/along-track on a spherical
   Earth), and time and altitude are interpolated at the closest point. This
   catches crossings that fall between samples.
4. _Qualify_ — a segment point within `overhead_radius_m` whose altitude is
   known and ≤ `max_altitude_ft`. The best such point is kept.
5. _Finalize_ — when a sample falls outside the search radius (`exited`),
   when no sample arrives for longer than the gap timeout (`timeout`), or when
   the same aircraft reappears after such a gap (`gap`, which also starts a new
   pass).

**Recording**

| outcome                                  | status / reason                                |
| ---------------------------------------- | ---------------------------------------------- |
| qualifying crossing                      | `qualified` / `crossed_within_overhead_radius` |
| within the radius but too high           | `near_miss` / `above_max_altitude`             |
| within the radius, altitude unknown      | `near_miss` / `unknown_altitude`               |
| closest ≤ max(3 × overhead radius, 3 km) | `near_miss` / `outside_overhead_radius`        |
| farther, or < 2 samples                  | dropped (not stored)                           |

`local_date` is the closest-approach date in the location's IANA time zone.

**Sampled points** — at most one point per `OVERFLIGHT_POINT_SAMPLE_SECONDS`
(30 s) and `OVERFLIGHT_POINT_MAX_PER_PASS` (200) per pass, plus the last
sample and a `closest_approach` point. Older points are removed by retention
(365 days by default).

## Aircraft and route enrichment (adsbdb)

ADS-B feeds such as adsb.lol carry only registration, type code and callsign.
An `Enricher` loop runs beside the poller (so lookups never delay polling) and
fills the rest from [adsbdb](https://www.adsbdb.com), a free, open aircraft
and flight-route database:

| Looked up by                                 | Fills                                                                                                                                                     |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mode S address (`/v0/aircraft/{hex}`)        | `aircraft.manufacturer`, `model` (e.g. `737-8`), `country`; the registered owner is kept in `raw_metadata.adsbdb` only (often a lessor, not the operator) |
| Airline callsign (`/v0/callsign/{callsign}`) | `overflights.flight_number`, `origin_code`, `destination_code` (IATA, else ICAO); `aircraft.operator_name/icao/iata` from the airline                     |

- Every `ENRICHMENT_INTERVAL_SECONDS` (30) it takes up to `ENRICHMENT_BATCH_SIZE`
  (10) aircraft and overflights without a finished lookup. Existing rows are
  therefore backfilled automatically. Requests are spaced ≥1.5 s apart.
- Each lookup is logged in `private.enrichment_attempts`; `success` and
  `not_found` are final, errors retry after an hour. A 429 or non-retryable
  error pauses enrichment for 10 minutes.
- After each aircraft lookup, anything adsbdb could not supply (manufacturer,
  model) is filled from the `aircraft_types` reference table by ICAO type
  code, so helicopters and private aircraft unknown to adsbdb still get e.g.
  `Bell` / `407`. adsbdb's airframe-specific values take priority.
- Aircraft fields are only filled when empty, so existing and manual values
  are never overwritten. The operator comes from the flight's airline (who is
  flying it today) and is skipped for aircraft marked `metadata_source = manual`.
- Routes are only looked up for overflights from the last 7 days: adsbdb
  returns today's route for a callsign, which is often wrong for old flights.
  Its routes are crowd-sourced and occasionally out of date.
- Only airline-style callsigns (`AAL2995`) are looked up; private aircraft
  usually broadcast their registration and have no route.
- Only public identifiers are sent — never coordinates. Set
  `ENRICHMENT_PROVIDER=none` to turn it off; it is off automatically with the
  mock provider.

## Display selection

A frame shows 1–4 planes. A `DisplayScheduler` loop runs beside the poller
every `DISPLAY_INTERVAL_SECONDS` (60) and, for every frame whose location is
active, decides which recent passes it should show. The logic lives in
`packages/display` and is pure and deterministic:

1. **Candidates**: the location's recorded passes from the last
   `window_hours` (a rolling window, default 6 h).
2. **Filters**: near misses (off by default), helicopters (on), airlines only
   (off).
3. **Score** (0–100): a weighted mean of five components, each 0–1:

   | component | meaning                                                                       | default weight |
   | --------- | ----------------------------------------------------------------------------- | -------------- |
   | rarity    | `0.7 / √(type sightings) + 0.3 / (airframe sightings)` at this location       | 3              |
   | proximity | half closeness (over 3 × overhead radius), half lowness (over max altitude)   | 2              |
   | recency   | linear over the window                                                        | 1              |
   | artwork   | best approved art: registration 1, livery 0.9, operator + type 0.75, type 0.4 | 2              |
   | detail    | share of model, operator, route and registration known                        | 1              |

4. **Pick** greedily by score: one pass per airframe and, by default, one
   plane per operator + type, up to `max_planes` (default 3).
5. **Commit**: a new `display_selections` row is written when the picked set
   differs from the current one **and** the current one has been up for
   `min_dwell_minutes` (default 60). An empty window never replaces what is
   on screen.

Every committed change will mean a render and an e-ink refresh, so the
fastest a frame can change is the longer of `min_dwell_minutes` and its wake
interval (`poll_interval_seconds`). Quiet hours (location time) push any
timer wake that would land inside them to their end; a button press still
gets the live window. Committed selections are the render queue for the
portrait renderer (next phase); until then frames keep serving posters.

Settings live in `public.device_display_settings` and are edited from the
admin board, whose preview runs exactly this code with draft settings.

## Cutouts (background removal)

When `CUTOUT_PROVIDER` is `rembg` or `remove_bg`, a `CutoutWorker` runs beside
the poller (`apps/worker/src/cutouts.ts`). Every `CUTOUT_INTERVAL_SECONDS` it
claims up to 3 queued `public.image_cutouts` rows (`for update skip locked`)
and for each:

1. re-checks the photo's licence (`cutoutRefusal` in `@overhead/core`): the
   owner's uploads and Wikimedia Commons photos only, never ND licences;
2. reads the photo: an upload from Storage, or the linked file (for Commons,
   the 2048 px rendering, falling back to the original), JPEG/PNG/WebP up to
   20 MB, with the provider User-Agent;
3. sends it to the background remover (`background-removers.ts`) and checks
   that a PNG came back;
4. stores it at `<owner>/cutout/<source_image_id>.png` in `source-images`
   (overwriting any earlier cutout) and marks the row `done`.

Failures are recorded on the row. Retryable ones (remover or download
outages, 5xx) are tried again after 2, then 4 minutes, up to 3 attempts;
permanent ones (not an image, too large, licence) stop at once. A rate limit
from the remover pauses the loop for at least 10 minutes (or `Retry-After`)
and hands the rest of the batch back. Rows left `processing` by a crashed
worker fail after 15 minutes and are retried. Requesting a cutout again resets
its attempts.

## Idempotency and restarts

- All pass state lives in `private.active_passes`; a restarted worker simply
  loads it. Tests prove a JSON round-trip of state mid-pass reproduces the
  uninterrupted result.
- Overflights are inserted with `ON CONFLICT (owner_id, location_id, provider,
provider_pass_key) DO NOTHING`, points with `ON CONFLICT DO NOTHING`, and the
  active pass is deleted by its pass key in the same transaction. A crash at
  any point either commits everything or nothing; replays never duplicate.
- Duplicate or older provider observations are ignored.

## Tests

`packages/flight-tracking/test/overflight-engine.test.ts` covers: direct
crossing; segment-only crossing; near miss; distant pass; above max altitude;
circling inside and outside the radius; missing samples; gap → two passes;
duplicate responses; restart mid-pass; restart after a long outage; midnight
in the location's time zone; two passes by one aircraft; unknown registration
and type; unknown altitude; taxiing/parked aircraft; out-of-order timestamps;
stale/future/implausible samples; input immutability.
`apps/worker/test/poller.test.ts` and `tests/integration/milestone.integration.test.ts`
cover the loop, crash retry, rate-limit backoff, persistence and API read-back.
