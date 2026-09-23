# HTTP API

The OpenAPI 3.1 document is generated from the route schemas and served at
`GET /openapi.json`; a snapshot is committed at [openapi.json](openapi.json)
(`bun run openapi` refreshes it).

## Conventions

- Application endpoints live under **`/api/v1`** and require
  `Authorization: Bearer <supabase_access_token>`.
- Every application response is an envelope:

  ```json
  { "data": { }, "error": null, "request_id": "0b6c…" }
  { "data": null, "error": { "code": "not_found", "message": "Location not found" }, "request_id": "0b6c…" }
  ```

- `X-Request-Id` is echoed (a well-formed inbound value is honoured).
- Bodies are strict: unknown fields are rejected. Default body limit 64 KiB.
- Lists use cursor pagination: `?limit=25&cursor=<next_cursor>`; responses
  are `{ items, next_cursor }`.
- Records owned by other users are indistinguishable from missing ones
  (`404`).

### Error codes

| code                     | HTTP | meaning                                            |
| ------------------------ | ---- | -------------------------------------------------- |
| `validation_failed`      | 400  | request failed validation (`details` lists fields) |
| `unauthorized`           | 401  | missing/invalid/expired access token               |
| `forbidden`              | 403  | not permitted                                      |
| `not_found`              | 404  | no such record (or not yours)                      |
| `conflict`               | 409  | uniqueness conflict or concurrent change           |
| `invalid_state`          | 409  | operation not valid in the record's current state  |
| `storage_object_missing` | 409  | referenced storage object has not been uploaded    |
| `payload_too_large`      | 413  | body over the limit                                |
| `rate_limited`           | 429  | slow down (`Retry-After` header)                   |
| `internal_error`         | 500  | unexpected failure (details only in server logs)   |
| `not_ready`              | 503  | readiness check failed                             |

## System

| Method | Path            |                                       |
| ------ | --------------- | ------------------------------------- |
| GET    | `/health`       | liveness                              |
| GET    | `/ready`        | configuration + database connectivity |
| GET    | `/openapi.json` | OpenAPI document                      |

## Profile

`GET /api/v1/profile`, `PATCH /api/v1/profile` (`display_name`, `timezone`).

## Locations

| Method | Path                     |                                                                                                               |
| ------ | ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/v1/locations`      | list — **coordinates omitted**                                                                                |
| POST   | `/api/v1/locations`      | create (`name`, `latitude`, `longitude`, optional radii/limits/timezone/is_active; defaults from `DEFAULT_*`) |
| GET    | `/api/v1/locations/{id}` | full record including coordinates                                                                             |
| PATCH  | `/api/v1/locations/{id}` | update                                                                                                        |
| DELETE | `/api/v1/locations/{id}` | delete (cascades to overflights, posters, worker state)                                                       |

## Aircraft

| Method | Path                    |                                                                                                                  |
| ------ | ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/v1/aircraft`      | search: `registration` (prefix), `icao24`, `type_code`, `manufacturer`, `model` (substring)                      |
| GET    | `/api/v1/aircraft/{id}` |                                                                                                                  |
| PATCH  | `/api/v1/aircraft/{id}` | correct curated metadata; sets `metadata_source = "manual"` so provider data stops overwriting registration/type |

Only aircraft you have observed (or attached imagery/art to) are visible.

## Overflights

| Method | Path                              |                                                                                                                                            |
| ------ | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/api/v1/overflights`             | filters: `location_id`, `from`/`to` (local dates), `registration`, `type_code`, `operator` (ICAO), `status`; newest closest-approach first |
| GET    | `/api/v1/overflights/{id}`        | detail; add `?include_position=true` for closest-approach coordinates                                                                      |
| GET    | `/api/v1/overflights/{id}/points` | sampled track points (private coordinates)                                                                                                 |

## Hangar

| Method | Path                           |                                                                                                                                                                   |
| ------ | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/v1/hangar`               | unique observed aircraft: first/last seen, pass count, qualified count, closest approach, lowest altitude, artwork availability (`has_artwork`, `best_art_scope`) |
| GET    | `/api/v1/hangar/{aircraft_id}` | entry + 20 most recent passes                                                                                                                                     |

## Source images

| Method           | Path                               |                                                                                         |
| ---------------- | ---------------------------------- | --------------------------------------------------------------------------------------- |
| POST             | `/api/v1/source-images/upload-url` | `{ filename, content_type }` → signed upload (`bucket`, `path`, `signed_url`, `token`)  |
| GET/POST         | `/api/v1/source-images`            | list / create (licence + attribution metadata, optional `storage_path` from upload-url) |
| GET/PATCH/DELETE | `/api/v1/source-images/{id}`       | delete also removes the stored object                                                   |

## Art assets

| Method           | Path                              |                                                                                                          |
| ---------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------- |
| POST             | `/api/v1/art-assets/upload-url`   | signed upload into `aircraft-art`                                                                        |
| GET/POST         | `/api/v1/art-assets`              | list (filters `status`, `scope`, `icao_type_code`, `aircraft_id`) / create (`draft` or `pending_review`) |
| GET/PATCH/DELETE | `/api/v1/art-assets/{id}`         | replacing the image of an approved asset returns it to `pending_review`                                  |
| POST             | `/api/v1/art-assets/{id}/approve` | verifies the image (and thumbnail) exist → `approved`                                                    |
| POST             | `/api/v1/art-assets/{id}/reject`  | → `rejected`                                                                                             |

## Posters

| Method           | Path                                            |                                                                                                                                                                       |
| ---------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET/POST         | `/api/v1/posters`                               | list (filters `location_id`, `status`) / create metadata (1200×1600 by default)                                                                                       |
| GET/PATCH/DELETE | `/api/v1/posters/{id}`                          | GET includes `items`; `PATCH {"status":"ready"}` downloads and verifies the device binary (exactly 960,000 bytes, valid Spectra 6 pixel codes) and records its sha256 |
| POST             | `/api/v1/posters/{id}/items`                    | `{ items: [{ overflight_id, art_asset_id?, display_order, rendered_labels? }] }`                                                                                      |
| POST             | `/api/v1/posters/{id}/device-binary-upload-url` | signed upload into `device-binaries`; resets a `ready` poster to `draft` until re-verified                                                                            |

## Devices

| Method           | Path                                       |                                                                               |
| ---------------- | ------------------------------------------ | ----------------------------------------------------------------------------- |
| GET/POST         | `/api/v1/devices`                          | POST returns `{ device, setup_secret }` — the secret is shown once            |
| GET/PATCH/DELETE | `/api/v1/devices/{id}`                     | responses include `enrollment_state`                                          |
| POST             | `/api/v1/devices/{id}/rotate-setup-secret` | new secret (shown once); `{"revoke_token": true}` also invalidates the bearer |
| POST             | `/api/v1/devices/{id}/request-reset`       | frame receives `reset: true` on its next display poll                         |

## Device protocol

`POST /device/v1/setup`, `GET /device/v1/display`, `POST /device/v1/log` —
see [device-protocol.md](device-protocol.md). These use the FlightPortrait
wire format, not the envelope.

## Uploading with a signed URL

```ts
const { data } = await api('POST', '/api/v1/art-assets/upload-url', {
  filename: 'b738.png',
  content_type: 'image/png',
});
await supabase.storage.from(data.bucket).uploadToSignedUrl(data.path, data.token, file);
await api('POST', '/api/v1/art-assets', {
  scope: 'type',
  icao_type_code: 'B738',
  storage_path: data.path,
});
```

Clients never choose bucket names; paths are generated server-side and
validated against the caller's id on every write.
