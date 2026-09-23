# Polling worker

`apps/worker` is a long-running Bun process:

```bash
bun run dev:worker                 # watch mode
bun run --filter @overhead/worker start   # after `bun run build`
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
  (`AIRPLANES_LIVE_USER_AGENT`, required) and are serialised with ≥1.1 s
  spacing (Airplanes.live allows roughly one request per second).
- A failing location backs off exponentially: 15 s × 2ⁿ⁻¹, capped at 15 min,
  plus up to 20 % jitter. Other locations keep polling.
- HTTP 429 honours `Retry-After` and pauses **all** locations (shared quota).
- A failed transaction leaves the previous state intact; the next tick
  recomputes from what was persisted.

## Providers

```ts
interface AircraftPositionProvider {
  readonly name: 'airplanes_live' | 'mock';
  getAircraftNear(input: {
    latitude: number;
    longitude: number;
    radiusNm: number;
  }): Promise<NormalizedAircraftPosition[]>;
}
```

- **Airplanes.live** (`GET /v2/point/{lat}/{lon}/{radius}`): responses are
  validated with Zod; invalid entries are skipped; `alt_baro: "ground"` marks
  ground traffic; the measurement time is `now − seen_pos`; empty strings
  become `null`. Fixture: `packages/flight-tracking/test/fixtures/airplanes-live-point.json`.
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
