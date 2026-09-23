# FlightPortrait-compatible device protocol

Overhead implements the "bring your own server" (BYOS) subset of the
FlightPortrait frame protocol.

**Sources and licences.** Behaviour follows
[`docs/PROTOCOL.md`](https://github.com/flightportrait/frame/blob/main/docs/PROTOCOL.md)
(© YODE PTE LTD, licensed **CC-BY-4.0**) and the reference server
[`examples/byos_server.py`](https://github.com/flightportrait/frame/blob/main/examples/byos_server.py)
(© 2026 YODE PTE LTD, **Apache-2.0**; repository NOTICE: "FlightPortrait
firmware, Copyright (c) 2026 YODE PTE LTD"), reviewed at commit `ce3335f`
(2026-07-31). This is an independent implementation; no FlightPortrait code is
copied. FlightPortrait is not affiliated with this project.

## Supported subset

| Endpoint                 | Supported                                                                | Not supported                                                                      |
| ------------------------ | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `POST /device/v1/setup`  | pairing-free setup; per-device setup secret; token rotation              | account-pairing extension (`device_ref`/`pairing` in the response)                 |
| `GET /device/v1/display` | bearer auth, telemetry, signed image URL, exact hash, `sleep_s`, `reset` | pairing headers/ack, `X-Power-Source` desk mode, OTA (`firmware` is always `null`) |
| `POST /device/v1/log`    | bounded batches, levels, timestamps                                      | —                                                                                  |

Device endpoints use the protocol's bare JSON bodies — **not** the API
envelope — and errors of the form `{"detail": "…"}` as in the reference
server. Every response still carries `X-Request-Id`.

## Enrollment

1. Owner registers the frame: `POST /api/v1/devices { name, mac_address, location_id }`.
   The response includes `setup_secret` (`ovh_…`, ≤159 bytes) exactly once;
   `private.device_credentials` stores only its SHA-256.
2. During BLE provisioning, the owner enters the server URL and that secret as
   the structured BYOS target (`fp-api-base` `{"url", "setup_secret"}`).
3. The frame calls setup; the secret arrives as `provision_secret`.

`POST /api/v1/devices/{id}/rotate-setup-secret` issues a new secret (optionally
revoking the current bearer).

## `POST /device/v1/setup`

Request: `{ "mac", "hw_rev"?, "provision_secret", "pairing_public_key"?, "pairing_counter"?, "pairing_nonce_hash"? }`

| Status                             | When                                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 200 `{"device_token": "<64 hex>"}` | MAC known and secret matches                                                                                 |
| 400                                | pairing fields present but malformed/partial                                                                 |
| 401 `{"detail":"bad secret"}`      | unknown MAC or wrong secret (indistinguishable, constant-time compare against a dummy hash for unknown MACs) |
| 413                                | body > 4 KiB                                                                                                 |
| 422                                | body missing, not JSON, or ill-typed                                                                         |
| 429                                | > 20 attempts / 10 min per IP, or > 10 / 10 min per MAC                                                      |

A fresh 256-bit token is generated per success; its SHA-256 replaces the
previous hash atomically, so **the old token stops working immediately**. The
reset flag is cleared (a re-setup is the factory-reset flow). Valid pairing
fields are accepted and ignored: as the protocol allows for BYOS servers, the
response contains only `device_token`, and the frame reports account pairing
as unavailable.

## `GET /device/v1/display`

Headers: `Authorization: Bearer <token>`, optional telemetry `X-Battery-Mv`,
`X-Rssi`, `X-Fw-Version`, `X-Boot-Reason` (`rtc | power-on | button | pairing`).
Telemetry is validated and stored on `public.devices` (`battery_mv`, `rssi`,
`firmware_version`, `last_boot_reason`, `last_seen_at`).

Response `200`:

```json
{
  "image_url": "https://<project>.supabase.co/storage/v1/object/sign/device-binaries/<owner>/bin/<poster>-<id>.bin?token=…",
  "image_hash": "sha256:<64 lowercase hex>",
  "sleep_s": 3600,
  "firmware": null,
  "reset": false
}
```

- **Poster choice**: the device's `latest_poster_id` if set, else the newest
  `ready` poster for the device's location — always the device owner's.
- **`image_url`**: a Storage signed URL valid for
  `DEVICE_SIGNED_URL_TTL_SECONDS` (default 300 s). The frame fetches it on the
  same wake and never stores it. URLs longer than 767 bytes (the firmware's
  768-byte buffer) are never sent; object paths are kept short for this reason.
- **`image_hash`**: exactly `sha256:` + the hash computed by the API when the
  poster was marked `ready` (see below).
- **`sleep_s`**: the device's `poll_interval_seconds` (60 s – 7 days). A
  `button` wake returns at most 300 s (the protocol's "live window"); a battery
  below 3,500 mV returns at least 86,400 s (one wake a day).
- **`reset`**: `true` after `POST /api/v1/devices/{id}/request-reset`, until
  the frame sets up again.

**No valid binary**: when no verified poster exists (or signing fails, or the
URL would not fit), the endpoint returns **`503 {"detail": …}`** — the
protocol's "render temporarily unavailable". The firmware treats every non-200
identically: it backs off (`min(2ⁿ × 5 min, 6 h)`) and retries, keeping the
current image on glass. No URL is ever invented. Note that a pending `reset`
is only delivered in a `200` response.

Other statuses: `401 {"detail":"unknown token"}` (missing/unknown/rotated
token), `429` (> 30 polls/min per token or > 120/min per IP).

## `POST /device/v1/log`

Body: `{ "logs": [ { "message", "level"?, "ts"? } ] }` — at most 32 entries,
messages 1–512 characters, `level` ∈ `debug | info | warn | error`
(default `error`), `ts` unix seconds (default: server time). Messages are
scrubbed of control characters and anything resembling a bearer token,
64-hex secret or `secret=…` before being stored in `private.device_logs`.
Returns `200 {"ok": true}`; `401`, `413` (> 32 KiB), `422`, `429`
(> 10 posts/min per token). Logs are pruned after 30 days and to the newest
500 per device.

## Panel binaries

A binary is exactly **960,000 bytes**: 1200×1600 portrait, 4 bits per pixel,
left pixel in the high nibble, pixel codes `0x0` black, `0x1` white, `0x2`
yellow, `0x3` red, `0x5` blue, `0x6` green. Rendering is deferred; binaries
are uploaded manually:

1. `POST /api/v1/posters/{id}/device-binary-upload-url` → signed upload into
   `device-binaries` at `<owner>/bin/<poster>-<id>.bin` (poster drops back to
   `draft` if it was `ready`).
2. Upload the bytes (`uploadToSignedUrl`).
3. `PATCH /api/v1/posters/{id} {"status":"ready"}` → the API downloads the
   object, checks size and pixel codes, computes SHA-256 and stores it via the
   trusted connection. Only then can a frame receive it.

## Security notes

- Tokens and setup secrets: generated with `crypto.getRandomValues`, stored as
  SHA-256 only, never logged (the logger redacts `authorization`, `token`,
  `*secret*` keys and bearer strings).
- The device endpoints read credentials through the trusted SQL connection;
  the `private` schema is not reachable through the Data API.
- On a plain-`http://` BYOS base the token crosses the network in cleartext
  (a protocol trade-off); deploy behind HTTPS.
