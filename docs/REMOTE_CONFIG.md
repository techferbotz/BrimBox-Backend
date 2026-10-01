# Remote config — `GET /config`

BrimBox's implementation of HOA protocol 10 (`G:\My Drive\HOA Protocols\10-remote-config-backend.md`).
The protocol is the source of truth for the contract; this page covers what is specific to BrimBox and
how to operate it.

## What it is

`GET /config` returns the app's behaviour switches: kill switches, update policy, maintenance mode, and
links. It is the app's first call on launch. Nothing about the caller is required. Optional headers
(`X-App-Platform`, `X-App-Version`, `X-App-Build`, `X-Device-Id`, and from P1 the access token) are the
inputs for targeting rules. Responses are `Cache-Control: no-store`; the app caches by `ttlSeconds`
(3600).

The document is built in three layers, each applied with a strict merge:

```
DEFAULT_REMOTE_CONFIG (code)  →  REMOTE_CONFIG_OVERRIDES (env, everyone)  →  RULES (code, targeted)
```

It is pure and synchronous: no database, so it answers even when Postgres is down.

## BrimBox's document

| Key | Default | Source |
|---|---|---|
| `features` | `{}` — no switches yet | One per feature as it ships, each `true` by default and announced with a `BE-nnn` |
| `update.minSupportedBuild` / `recommendedBuild` | `0` / `0` | `remoteConfig.defaults.ts` |
| `update.androidStoreUrl` / `iosStoreUrl` / `message` | `null` | Fill `androidStoreUrl` once the Play listing exists |
| `maintenance.enabled` / `message` | `false` / `null` | `remoteConfig.defaults.ts` |
| `links.privacyPolicy` / `terms` / `deleteAccount` | `${APP_PUBLIC_URL}/privacy` … | Built from `config.appPublicUrl` + `LEGAL_PATHS` |
| `links.supportEmail` | `support@ferbotz.com` | Imported from `LEGAL_CONTACT_EMAIL` in `modules/legal/legal.view.ts` |

Planned additions follow protocol 10's "mirrored, never retyped" rule. Each value is imported from the
module that enforces it:
- `features.*` switches for uploads (P3) and sharing (P7). There's no sign-in switch: BrimBox can't be
  used signed out, so `maintenance` is the lever there.
- An `upload` section mirroring the server's limits: max file size, part size, concurrency.
- A `billing` section with the limit-alert percentages.

## Operating it

**Flip a value for everyone without a deploy.** On the box, edit the server `.env` — one line, no quotes
around the JSON — then recreate the container:

```bash
cd /opt/apps/brimbox/BrimBox-Backend
# in .env:
# REMOTE_CONFIG_OVERRIDES={"maintenance":{"enabled":true,"message":"Back in 10 minutes"}}
docker compose -f docker-compose.prod.yml up -d app
curl -s https://brimbox.ferbotz.com/config
```

A key that doesn't exist in the defaults, or a value of the wrong type, **fails startup** with the
offending path in the log (`docker compose -f docker-compose.prod.yml logs --tail=50 app`). That is
deliberate: the app ignores unknown keys, so a typo would otherwise silently do nothing. Remove the line
and recreate to go back to the defaults.

**Target a subset** (an old build, a platform, an experiment arm, a QA user): add a rule to
`src/modules/remoteConfig/remoteConfig.rules.ts`. That file explains the pattern, including how to bucket
on `deviceId` and why to guard its `null`.

**Add a key:** add it to `RemoteConfig` (`dto/`) and to `DEFAULT_REMOTE_CONFIG` with today's behaviour as
the value, run `npm run check:config`, and log a `BE-nnn` entry in the contract folder. Never remove or
rename a key without bumping `SCHEMA_VERSION`. Prefer adding a new key.

## Verification

`npm run check:config` (no DB, no network) pins:
- the strict merge
- header parsing
- day-one defaults
- override and rule ordering
- fail-at-boot validation
- `resolveConfig` parity

`npm run check:legal` pins that `links.*` point at the routes this backend actually serves.
