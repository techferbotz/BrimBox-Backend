# BrimBox Backend

Backend for **BrimBox**, a pay-as-you-use cloud storage app. Users keep files and folders in the cloud
and pay each month for the storage they actually used: a monthly bill collected through a UPI AutoPay /
card mandate with a limit the user chooses, with Google Play credits alongside. The client is a Kotlin
Multiplatform app, **Android first**, iOS later.

**The design is in [`docs/BACKEND_PLAN.md`](docs/BACKEND_PLAN.md)** — architecture, data model, metering,
billing, and the phased roadmap (§12). Read it before building a phase. **Current phase: P0 (foundations).**

## House of Apps protocols

This project follows the shared HOA playbook in `G:\My Drive\HOA Protocols\`. Read `README.md` there
first; it indexes the rest. The ones that bind this repo:

- **00 — New project setup**: Drive folder `G:\My Drive\BrimBox\`, details doc, credentials registry,
  docs mirror, contract folder.
- **01 — Server ↔ client contract**: `G:\My Drive\BrimBox\BrimBox-Contract\` is the **only** channel to
  the app. Write only in `backend/`; read `app/REQUESTS.md` past the watermark in `backend/applied.md`;
  log every app-observable change as a `BE-nnn` entry in `backend/CHANGELOG.md`. **Never read or clone
  the app's repository.** `backend/API.md` mirrors `docs/FRONTEND_API.md` — refresh it in the same change.
- **02 — Claude ↔ AWS access**: security-group edits, IAM changes and public-bucket policies are
  **human-run**, never agent-run. Prepare the exact command and hand it over. The same goes for the
  Cloudflare dashboard (DNS, R2 bucket + token) and the Razorpay / Play Console accounts.
- **03 — AWS infrastructure**: shared EC2 box, host Postgres (database + role per project), loopback-only
  container port, nginx vhost + certbot.
- **04 — Tech stack & conventions**: the stack below. Deviate only with a written reason (next section).
- **05 — Deployment runbook**: migrate **before** rebuilding the app, and always pass `--build` to the
  migrate service or it silently runs a stale image.
- **10 — Remote config** (`GET /config`) and **12 — Legal pages** (`/privacy`, `/terms`,
  `/delete-account`): present from day one.

### Deviations from protocol 04, and why

Full reasons in `docs/BACKEND_PLAN.md` §2.

- **D1 — Tokens expire.** 1-hour access JWT + a rotating refresh token per device (Billanta's pattern),
  not the house's permanent token. Protocol 04 itself says to reinstate expiry for payment/sensitive
  surfaces: BrimBox holds private files and a mandate on the user's bank account. (Lands in P1.)
- **D2 — Files never touch this server.** Cloudflare R2, private bucket, presigned direct upload/download,
  multipart for large files, originals stored byte-exact. No multer, no sharp in the request path, no
  public-read objects.
- **D3 — The app makes thumbnails** and uploads them with the file; the shared box has no CPU/RAM to spare.
- **D4 — Sync cursor is a server-assigned per-user sequence**, not the client's `updatedAt` (client UUIDs,
  tombstones and last-write-wins stay as in protocol 04).
- **D5 — A long-running `worker` service** with advisory locks and a `JobRun` table runs scheduled jobs,
  instead of host-crontab scripts. (Lands with the first job.)
- **D6 — Razorpay recurring payments** (the mandate) plus RevenueCat (Play credits).
- **D7 — FCM + Amazon SES** for billing alerts, each behind one file.
- **Smaller ones:** the failure envelope always carries `code` (allowed by `code?`); no Prisma until P1,
  because nothing reads a database before then.

## Commands

```bash
npm run dev          # ts-node-dev on http://localhost:8080
npm run typecheck    # tsc --noEmit — run after every change
npm run build        # tsc -> dist/
npm run check:all    # every check:* fixture script (check:config, check:legal)
```

Local env: copy `.env.example` to `.env`. Variables are read **only** in `src/config/env.ts`:

| Variable | Required | Meaning |
|---|---|---|
| `PORT` | no (8080) | Listen port; 8080 inside the container |
| `APP_PUBLIC_URL` | yes | Public origin, e.g. `https://brimbox.ferbotz.com` — legal links in `/config` are built from it |
| `REMOTE_CONFIG_OVERRIDES` | no | JSON patch over the default `/config` document; a bad patch fails startup |
| `APP_HOST_PORT` | prod only | Loopback port compose publishes on the box (8094) |

## Directory map

```
src/
  app.ts                        express app: middleware, root routes, 404, error handler, listen
  config/env.ts                 the only reader of process.env (fail fast)
  common/                       deepMerge, errors/ (AppError + handler), response/, middleware/
  modules/
    remoteConfig/               GET /config (protocol 10)
    legal/                      /privacy /terms /delete-account (protocol 12) + public-promise constants
  scripts/check-*.ts            fixture checks, no DB/network
  types/express.d.ts            req.userId / req.deviceId
docs/                           BACKEND_PLAN.md, FRONTEND_API.md, REMOTE_CONFIG.md, DEPLOY.md
```

Feature modules follow Billanta/Curiously: `modules/<f>/<f>.routes.ts` + `controller/ service/
repository/ dto/`. External SDKs each sit behind exactly one file (`storage/r2Storage.ts`,
`integrations/razorpay.ts`, …).

## Conventions

- Envelope: `{ success: true, data }` / `{ success: false, code, message }`. Throw `AppError`
  subclasses; never write an error response by hand. Express 5 forwards rejected promises to the
  error handler, so no `asyncHandler`.
- Routes: app API under `/api/v1`; `/`, `/config`, the legal pages, share pages (`/s/:token`),
  `/webhooks/*` and `/admin` at the root.
- Layering: route → controller → service → repository; **Prisma only in repositories**.
- Ownership scoped by `userId` on every query; someone else's row is a **404, never a 403**.
- **Money** (from P4): integer paise in `BigInt`, decimal strings on the wire, `decimal.js` half-up, all
  arithmetic in one `money.ts`. Metering keeps exact charges in micro-paise; statements round once.
- **Every change to stored bytes goes through `metering.recordStorageChange()`** in the same transaction
  as the metadata change (from P3). Bills are computed from the append-only `StorageEvent` log.
- Remote config is **additive-only**; numbers the server enforces are imported into the defaults, never
  retyped.
- Legal pages: **only claim what the code does**. When data handling changes, change
  `modules/legal/legal.view.ts` in the same commit. Public promises (retention days, billing windows) are
  constants there until their enforcing module lands, then move to it and are imported back.

## Gotchas

- Migrations NEVER run on container start — a discrete `migrate` compose service (from P1).
- Prisma is pinned to v6 (v7 drops `url = env("DATABASE_URL")` and needs a driver adapter).
- R2 multipart: every part except the last must be the same size; R2 has no presigned POST. Always
  verify uploaded sizes with `HeadObject` — never bill a client-declared size.
- The request logger prints URLs: redact share tokens (`/s/:token`) before P7 ships.
- The shared box (t3.small since 2026-10-01) runs five apps plus Postgres, and its disk is about 86%
  full. Check `df -h /` before an image build, and never prune Docker without asking: the unused
  images may be other apps' rollback copies (`docs/DEPLOY.md` § The box).
