<!--
  Reference doc — the current contract the BrimBox app builds against.
  Source of truth: the backend repo's docs/FRONTEND_API.md. Mirrored to
  BrimBox-Contract/backend/API.md whenever a CHANGELOG entry says this file moved.
  Last refreshed: 2026-10-01 (BE-002).
-->

# BrimBox — Frontend (Client) API

Everything the app needs to build its data layer. Examples are JSON and stack-agnostic.

- **Base URL:** `https://brimbox.ferbotz.com`
- **API prefix:** app endpoints live under **`/api/v1`** (§4 onwards). These are unversioned and fixed
  across House of Apps backends: `GET /` (health), `GET /config`, and the legal pages.
- **Content type:** `application/json` for request bodies. File bytes are never sent to this API
  (see §2).

---

## 1. Global conventions

**Success envelope** — the payload is always under `data`:

```json
{ "success": true, "data": { } }
```

**Error envelope** — flat, and `code` is **always present**. Branch on `code` (a stable string), and
show `message` only if you have nothing better:

```json
{ "success": false, "code": "NOT_FOUND", "message": "Route not found: GET /nope" }
```

| code | HTTP | When |
|---|---|---|
| `BAD_REQUEST` | 400 | The request failed validation |
| `INVALID_JSON` | 400 | The body isn't valid JSON |
| `UNAUTHORIZED` | 401 | No access token on a protected call → refresh (§4) |
| `INVALID_TOKEN` | 401 | Access token expired, invalid, or its device was signed out → refresh (§4) |
| `FORBIDDEN` | 403 | Signed in, but not allowed to do this |
| `NOT_FOUND` | 404 | No such route, or the resource doesn't exist / isn't yours |
| `PAYLOAD_TOO_LARGE` | 413 | Body over 1 MB (bodies are small JSON; files go to storage directly) |
| `RATE_LIMITED` | 429 | Too many requests. The `Retry-After` header says how many seconds to wait |
| `SERVICE_UNAVAILABLE` | 503 | A feature isn't configured on the server yet |
| `INTERNAL` | 500 | A server bug |

Endpoint-specific codes are listed with each endpoint.

**Headers to send on every request** (HOA protocol 11). All optional; garbled values are ignored,
never rejected:

```
X-App-Platform: android        # "android" | "ios" | "web"
X-App-Version: 1.4.2           # display version
X-App-Build: 1042              # integer build number (versionCode)
X-Device-Id: <install uuid>    # stable per-install id
```

**Data types**

- **IDs** are UUID strings. For folders, files and uploads the **app generates the id**, and writes are
  idempotent by id, so a retry after a dropped connection is always safe.
- **Money** is a decimal **string** of **paise**: `"4327"` is ₹43.27. Never a float, never rupees.
- **Sizes** are JSON numbers of **bytes**. 1 GB = 1,000,000,000 bytes, the unit phones display.
- **Timestamps** are ISO-8601 UTC strings. Billing days and months follow India time (`Asia/Kolkata`).

---

## 2. How BrimBox differs from the other House of Apps backends (plan ahead)

Each arrives as its own `BE-nnn` entry with the exact contract. They shape the client's architecture,
so they are listed together here:

- **Access tokens expire** (live since BE-002, §4). Sign-in returns a short-lived access token (1 hour)
  **and** a refresh token for the device. The app refreshes silently; users are never sent back to
  sign-in on a timer.
- **File bytes never go through this API.** The API hands out short-lived signed URLs; the app uploads
  to and downloads from cloud storage directly. Large uploads are multipart and resumable. Never cache a
  signed URL past its `expiresAt`.
- **The app makes the thumbnails.** Each upload includes a small WebP preview made on the device.
- **Sync is a change feed** with an opaque cursor (`GET /api/v1/sync/changes`), designed for a local
  Room cache.

---

## 3. Endpoints

### `GET /` — health

Plain text `BrimBox Backend Running`. No auth.

### `GET /config` — remote config (HOA protocols 10/11)

The app's first call on launch. Nothing about the caller is required; send the headers from §1. The
response is `Cache-Control: no-store`; cache it yourself for `ttlSeconds` and re-fetch on every cold
start. Launch must never block on it: use compiled-in defaults, then the cached copy, then the network.

```json
{
  "success": true,
  "data": {
    "schemaVersion": 1,
    "variant": "default",
    "revision": "3f2a9c0d1b7e",
    "ttlSeconds": 3600,
    "config": {
      "features": {},
      "update": {
        "minSupportedBuild": 0,
        "recommendedBuild": 0,
        "androidStoreUrl": null,
        "iosStoreUrl": null,
        "message": null
      },
      "maintenance": { "enabled": false, "message": null },
      "links": {
        "privacyPolicy": "https://brimbox.ferbotz.com/privacy",
        "terms": "https://brimbox.ferbotz.com/terms",
        "deleteAccount": "https://brimbox.ferbotz.com/delete-account",
        "supportEmail": "support@ferbotz.com"
      }
    }
  }
}
```

| Key | Meaning |
|---|---|
| `features.*` | Kill switches, `true` = on. **None yet** — BrimBox adds one per feature as it ships. A key missing from the response means "use your compiled-in default (on)". |
| `update.minSupportedBuild` | Builds below this must update to continue (hard block). `0` = none. |
| `update.recommendedBuild` | Builds below this get a dismissible update nudge. `0` = none. |
| `update.androidStoreUrl` / `iosStoreUrl` / `message` | Where to send the user, and optional copy. Nullable. |
| `maintenance.enabled` / `message` | `true` → show `message` instead of loading the app. |
| `links.*` | Absolute URLs of the legal pages and the support address. **Never hard-code these.** |

Keys are only ever added. Ignore keys you don't know.

### Legal pages — `GET /privacy`, `GET /terms`, `GET /delete-account`

Public HTML pages (aliases: `/privacy-policy`, `/terms-of-service`, `/account-deletion`). Open them from
`links.*` in an in-app browser (Custom Tabs on Android):

- **Settings / Profile / About:** "Privacy Policy", "Terms & Conditions", "Delete account", and
  "Contact support" (`mailto:` `links.supportEmail`).
- **Sign-in:** the consent line *"By continuing you agree to our Terms & Conditions and Privacy
  Policy"*, with both phrases linked.
- **Billing / purchase screens:** link the Terms and the Privacy Policy.

The delete-account page tells reviewers that the in-app path is **Settings → Account → Delete account**,
followed by a Google account confirmation (§5). If the app's screens end up named differently, send an
`APP-nnn` request so the page matches. Play reviewers follow the steps literally.

---

## 4. Sign-in and sessions

### The token model

1. **Sign in with Google** on the device (Credential Manager / "Sign in with Google") using BrimBox's
   **server client id** — the OAuth *web* client id, published in the contract folder once it exists.
   Until then `POST /api/v1/auth/google` answers `503 SERVICE_UNAVAILABLE`.
2. Send the resulting **idToken** to `POST /api/v1/auth/google`. You get back:
   - an `accessToken`, which lasts `expiresIn` seconds (3600);
   - a `refreshToken` for this device;
   - the `user`.
3. Send `Authorization: Bearer <accessToken>` on every `/api/v1` call **except** `/api/v1/auth/*`.
   Exclude those three endpoints from your bearer-auth plugin.
4. **When a protected call returns `401`** (`UNAUTHORIZED` or `INVALID_TOKEN`; the response carries
   `WWW-Authenticate: Bearer`):
   1. Call `POST /api/v1/auth/refresh` **once** with the stored refresh token.
   2. Store **both** new tokens: the refresh token changes on every refresh.
   3. Retry the original call.

   If the refresh itself fails (`INVALID_REFRESH_TOKEN` or `REFRESH_TOKEN_REUSED`), clear both tokens
   and show sign-in. A bearer plugin with a refresh callback, such as Ktor's `Auth`, is exactly this
   shape. You may also refresh ahead of time, shortly before `expiresIn` runs out.
5. **One refresh in flight at a time.** If a refresh times out and you never saw its response,
   retrying with the **same** refresh token within **60 seconds** is safe: you get fresh tokens. Outside
   that window, replaying an old refresh token is treated as theft, and the device is signed out
   (`REFRESH_TOKEN_REUSED`).
6. A device that isn't used for **90 days** is signed out (refresh returns `INVALID_REFRESH_TOKEN`).
7. **Store the refresh token encrypted**, using Android Keystore-backed storage. It is the long-lived
   credential, and the server only keeps its hash, so it can never be shown again.

One session exists per install: signing in again with the same `X-Device-Id` replaces that install's
session. Revocation is immediate: once a device is signed out (§5), its access token stops working at
once, not after the hour.

### `POST /api/v1/auth/google`

Send `X-Device-Id`, `X-App-Platform` and `X-App-Version` as on every request. They label this device in
the session list.

```json
{ "idToken": "<Google idToken>", "deviceName": "Pixel 8" }
```

`deviceName` is optional (at most 100 characters), shown in the device list.

```json
{
  "success": true,
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiIs…",
    "expiresIn": 3600,
    "refreshToken": "q5Vn2…43 characters",
    "user": {
      "id": "388dbc11-d6f4-4232-adc1-11b9476f1f58",
      "email": "asha@example.com",
      "name": "Asha",
      "photoUrl": "https://lh3.googleusercontent.com/…",
      "createdAt": "2026-10-01T09:50:11.854Z"
    },
    "isNewUser": true
  }
}
```

| code | HTTP | When |
|---|---|---|
| `BAD_REQUEST` | 400 | `idToken` missing or not a string |
| `INVALID_ID_TOKEN` | 401 | Google rejected the idToken (wrong app, expired, forged, or no verified email) |
| `RATE_LIMITED` | 429 | Too many sign-ins from this network |
| `SERVICE_UNAVAILABLE` | 503 | Sign-in isn't configured on the server yet |

`user.email`, `name` and `photoUrl` come from the Google account and refresh on every sign-in. Any of
them can be `null`.

### `POST /api/v1/auth/refresh`

`{ "refreshToken": "<stored refresh token>" }` returns `{ "accessToken", "expiresIn", "refreshToken" }`
(no `user`).

| code | HTTP | When → what to do |
|---|---|---|
| `INVALID_REFRESH_TOKEN` | 401 | Unknown, expired or signed out → clear tokens, sign in |
| `REFRESH_TOKEN_REUSED` | 401 | The token was replayed after being replaced, so the device was signed out for security → clear tokens, sign in |

### `POST /api/v1/auth/logout`

`{ "refreshToken": "<stored refresh token>" }` returns `{}`, **always**, whether or not the token was
live. Call it on sign-out, then clear both tokens locally.

---

## 5. Account and devices (🔒 access token required)

### `GET /api/v1/me`

Returns the `user` object (same shape as in sign-in).

### `GET /api/v1/me/sessions`

The account's signed-in devices, most recently used first. `current` is `true` for the device making
the call, so label it "This device".

```json
{
  "success": true,
  "data": [
    {
      "id": "26d0806d-a242-485f-b99e-65fe3d12f67d",
      "deviceName": "Pixel 8",
      "platform": "android",
      "appVersion": "0.1.0",
      "createdAt": "2026-10-01T09:50:11.815Z",
      "lastUsedAt": "2026-10-01T09:50:11.815Z",
      "current": true
    }
  ]
}
```

`lastUsedAt` updates at most every 5 minutes.

### `DELETE /api/v1/me/sessions/{id}`

Signs out one device and returns `{}`. Using the current session's id signs out this device. An
unknown id, or another account's, returns `404 NOT_FOUND`.

### `POST /api/v1/me/sessions/revoke-others`

"Sign out all other devices" (e.g. after losing a phone). Returns `{ "revoked": 2 }`.

### `PUT /api/v1/me/push-token`

`{ "token": "<FCM registration token>" }` returns `{}`.
- **When to call:** after sign-in, and again whenever FCM rotates the token.
- **To stop notifications** on this device, send `{ "token": null }`.
- **Signing out** this device drops its token automatically.

Notifications themselves (usage alerts, bills) arrive in a later phase.

### `DELETE /api/v1/me` — delete the account

`{ "idToken": "<Google idToken from a FRESH sign-in>" }` returns `{}`.

Account deletion is irreversible, and from the file-storage phase onwards it takes every stored file
with it. So it needs proof that the owner is present, not just a valid access token:
1. Run Google sign-in again (same server client id).
2. Send that idToken here within **10 minutes**.

On success:
- every device of the account is signed out;
- clear all local data and tokens;
- show a confirmation.

Signing in again later with the same Google account creates a **new, empty** account.

| code | HTTP | When → what to do |
|---|---|---|
| `BAD_REQUEST` | 400 | `idToken` missing |
| `REAUTH_REQUIRED` | 403 | The idToken was invalid or older than 10 minutes → run Google sign-in again and retry |
| `REAUTH_MISMATCH` | 403 | The user picked a different Google account → ask them to choose the one this BrimBox account uses |
| `RATE_LIMITED` | 429 | Too many attempts |
| `SERVICE_UNAVAILABLE` | 503 | Sign-in isn't configured on the server yet |

These are 403s, not 401s, so they don't trigger your token-refresh flow.
