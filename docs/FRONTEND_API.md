<!--
  Reference doc — the current contract the BrimBox app builds against.
  Source of truth: the backend repo's docs/FRONTEND_API.md. Mirrored to
  BrimBox-Contract/backend/API.md whenever a CHANGELOG entry says this file moved.
  Last refreshed: 2026-10-01 (BE-001).
-->

# BrimBox — Frontend (Client) API

Everything the app needs to build its data layer. Examples are JSON and stack-agnostic.

- **Base URL:** `https://brimbox.ferbotz.com`
- **API prefix:** app endpoints live under **`/api/v1`** (none yet — they start with sign-in). These
  are unversioned and fixed across House of Apps backends: `GET /` (health), `GET /config`, and the
  legal pages.
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
| `NOT_FOUND` | 404 | No such route, or the resource doesn't exist / isn't yours |
| `PAYLOAD_TOO_LARGE` | 413 | Body over 1 MB (bodies are small JSON; files go to storage directly) |
| `SERVICE_UNAVAILABLE` | 503 | A feature isn't configured on the server yet |
| `INTERNAL` | 500 | A server bug |

More codes arrive with the endpoints that raise them; each is listed in that endpoint's section.

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

These land in later phases. Each arrives as its own `BE-nnn` entry with the exact contract, but they
shape the client's architecture, so they are listed now:

- **Access tokens expire.** Sign-in returns a short-lived access token (about 1 hour) **and** a refresh
  token for the device. Refresh silently when a call returns `401` — a bearer-auth plugin with a refresh
  callback (e.g. Ktor's `Auth`) is the expected shape. Users are not sent back to sign-in on a timer.
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

The delete-account page tells reviewers that the in-app path is **Settings → Account → Delete account**.
If the app's screens end up named differently, send an `APP-nnn` request so the page matches. Play
reviewers follow the steps literally.
