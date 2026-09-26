# Security

## Assets

1. **Home coordinates** (`locations.latitude/longitude`, overflight closest
   points and track points — anything near the location reveals it).
2. **Credentials**: Supabase secret key, `DATABASE_URL`, device setup secrets
   and bearer tokens, user access tokens.
3. **User data**: observations, artwork, posters, device telemetry.
4. **Integrity of what a frame displays.**

## Trust boundaries

| Actor              | Can                                                                                                                                 | Cannot                                                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Anonymous internet | `/health`, `/ready`, `/openapi.json` (rate limited), device endpoints with a valid device credential                                | any `/api/v1` route; any Data API table (anon has no grants)                                              |
| Authenticated user | own rows via `/api/v1` or PostgREST under RLS; own storage prefix                                                                   | other users' rows/objects; `private` schema; worker-owned columns (telemetry, binary hashes, overflights) |
| Admin              | everything a user can, across all owners, through `/admin/v1`: users, frames, telemetry, display settings, location detection rules | see coordinates (admin queries never select them) or credentials                                          |
| Frame              | its own display/log/setup                                                                                                           | anything outside its owner's posters                                                                      |
| API process        | user-scoped queries with the caller's token; trusted SQL scoped by owner/device; sign device URLs                                   | —                                                                                                         |
| Worker             | trusted SQL                                                                                                                         | receives no user input                                                                                    |

## Threats and mitigations

| Threat                             | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cross-tenant data access           | RLS on every exposed table with explicit per-command ownership policies (`(select auth.uid())`); UPDATE policies have `USING` + `WITH CHECK`; handlers also filter by `owner_id`; composite `(owner_id, id)` FKs stop cross-owner references even from trusted code; security-invoker views; pgTAP + integration tests prove isolation.                                                                                                                                                                            |
| Over-broad Data API exposure       | Default privileges revoked; explicit column-scoped grants; `private` schema not exposed and has no grants; `anon` gets nothing.                                                                                                                                                                                                                                                                                                                                                                                    |
| Authorisation via spoofable claims | Only `sub` and `role` from verified JWTs (`auth.getClaims`) are used; `user_metadata` is never consulted.                                                                                                                                                                                                                                                                                                                                                                                                          |
| Location leakage                   | Lists omit coordinates; overflight coordinates require `include_position=true`; coordinates are never logged (logger redacts coordinate keys; worker scrubs error text; provider URLs are never logged); coordinates never appear in URLs we generate; fixtures and seed use fake points near 0°, 0°. The admin board's airspace view (My locations) draws the owner's coordinates in their browser only; its street map is off by default because its OpenStreetMap tiles reveal the area shown to OSM's servers. |
| Secret leakage                     | Secret key only in server env; never returned; logger redacts `sb_secret_…`, bearer strings and credential keys; env validation never echoes values. Device setup secrets shown once; only hashes stored.                                                                                                                                                                                                                                                                                                          |
| Device token theft / brute force   | 256-bit random tokens, SHA-256 at rest, unique hash index, immediate rotation on re-setup; setup rate-limited per IP and per MAC; constant-time secret comparison, identical responses for unknown MAC vs wrong secret; failed attempts counted.                                                                                                                                                                                                                                                                   |
| Serving tampered/invalid images    | Binaries verified server-side (size + pixel codes) and hashed by the API; users cannot write `binary_sha256` or `device_binary_path`; frame verifies hash + size before blitting.                                                                                                                                                                                                                                                                                                                                  |
| Storage abuse / path traversal     | Server-generated owner-prefixed paths; filename sanitisation; path validation on every write; fixed bucket names (clients never choose); per-bucket MIME and size limits; owner-prefix storage policies for SELECT/INSERT/UPDATE/DELETE; short-lived signed URLs.                                                                                                                                                                                                                                                  |
| Artwork approval without an image  | API checks object existence, and the RLS `WITH CHECK` independently requires the `storage.objects` row.                                                                                                                                                                                                                                                                                                                                                                                                            |
| SSRF                               | No endpoint fetches caller-supplied URLs; source-image URLs are stored as metadata only.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Injection                          | Zod validation on every input (strict bodies); PostgREST query builder; parameterised Bun SQL; `LIKE` wildcards escaped; cursor values validated before use.                                                                                                                                                                                                                                                                                                                                                       |
| Abuse / DoS                        | Body limits (64 KiB API, 4 KiB setup, 32 KiB logs); rate limits (system per IP, API per user, device per token/IP/MAC); bounded log batches; paginated lists (max 100); retention for points and logs.                                                                                                                                                                                                                                                                                                             |
| Browser attacks                    | CORS allowlist (default: none); `secureHeaders` (CSP `default-src 'none'`, `frame-ancestors 'none'`, HSTS, nosniff, no-referrer); `Cache-Control: no-store`.                                                                                                                                                                                                                                                                                                                                                       |
| Provider misuse                    | Descriptive User-Agent, request spacing, 429 handling with global pause, exponential backoff. adsbdb receives only Mode S addresses and airline callsigns, and Planespotters.net and Wikimedia Commons (admin photos, server-side, cached) only Mode S addresses and registrations: public identifiers, never coordinates. Cutouts send only the photo itself to the configured background remover (self-hosted rembg or remove.bg), and only for photos whose licence allows edited copies.                       |

## Residual risks and notes

- **In-memory rate limiting** is per API instance. Running several instances
  multiplies limits; use a shared store (e.g. Redis/Upstash) or edge limits
  before scaling out.
- **Trusted connection role**: `DATABASE_URL` uses the `postgres` role, which
  bypasses RLS. Code scopes every trusted query by owner/device, but a
  dedicated least-privilege login role for the API/worker is recommended for
  production (see deployment.md).
- **`aircraft` is shared reference data.** A user may edit curated fields of an
  aircraft they observed; in a multi-owner deployment such edits are visible
  to other observers of the same airframe.
- **Signed upload URLs** from Supabase Storage are valid for two hours (not
  configurable); they are scoped to one owner-prefixed path.
- **Plain HTTP BYOS**: frames allow `http://` custom servers; tokens would then
  be sent in cleartext. Serve the device endpoints over HTTPS.
- **Token revocation latency**: `auth.getClaims` verifies JWTs locally with
  asymmetric keys, so a signed-out session remains valid until its expiry
  (default 1 hour). Use `auth.getUser` if immediate revocation is required.

- **Admins read across owners.** `/admin/v1` uses the trusted connection
  behind `requireUser` + `requireAdmin` (membership of `private.admins`,
  which no Data API role can read or write). Admin queries never select
  coordinates; an admin sees and edits coordinates only for their own
  locations, through the ordinary owner-scoped `/api/v1` routes. Admins can
  also upload artwork into any user's `aircraft-art/<owner>/art/` folder
  (server-generated paths, validated per owner) and see every user's images
  through 10-minute signed URLs. Keep the admin list to people you trust with
  everyone's sightings.

## Operational checks

```bash
bun run db:test                                   # pgTAP security suite
bun run test:integration                          # isolation, storage, grants
bunx supabase db advisors --local --type all      # or --linked for hosted
git grep -nE "sb_secret_|eyJhbGci|BEGIN (RSA|EC) PRIVATE"   # must be empty
```
