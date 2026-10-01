# BrimBox Backend — Implementation Plan

**Status:** draft for review · **Date:** 2026-10-01 · **Slug:** `brimbox` · **Domain:** `brimbox.ferbotz.com`

BrimBox is a pay-as-you-use cloud storage app. Users keep files and folders in the cloud. Each month they
pay for the storage they actually used, through an auto-debit mandate with a cap they choose. The client
is Kotlin Multiplatform, launching on Android first.

This backend follows the HOA protocols (`G:\My Drive\HOA Protocols\`). Every deviation is listed with its
reason in §2.

---

## 0. Decisions so far

| Topic | Decision | Source |
|---|---|---|
| Billing model | **Postpaid, capped by a mandate.** The user approves a UPI AutoPay / card mandate with a cap (e.g. ₹100). Each month BrimBox debits the actual usage, up to the cap. The user is alerted as usage nears or passes the cap. | Product decision |
| Payments | Razorpay recurring payments for the mandate (new vendor). Google Play credit packs via RevenueCat (house pattern), required for Play compliance (§7.6). | §7.6 |
| File storage | Cloudflare R2: one private bucket, Asia-Pacific location hint. | Product decision |
| v1 features | Folders, upload/download, trash, search, sync feed, **share links** | Product decision |
| Platforms | Android first, with Google sign-in only. iOS later (adds Sign in with Apple). | Product decision |
| Stack | HOA protocol 04: Express 5, TypeScript strict/CJS, Prisma 6, PostgreSQL, Node 22, Docker | House standard |

**Storage options considered (2026-10-01):**

| Option | Verdict |
|---|---|
| AWS S3 (house default) | Rejected. Download fees (~$0.09/GB) would dominate a pay-as-you-use price. |
| Google Drive API, every user's files in one BrimBox account | Rejected. Google's terms forbid reselling the service. One account suspension would take every user offline. Hard caps: 750 GB of uploads per account per day, and 500,000 items per shared drive. No signed download links, so every download would have to pass through our server. |
| Google Drive API, each user's own Drive | Works technically, but the files use storage the user buys from Google, so BrimBox would have nothing to bill for. That is a different product. |
| Google Cloud Storage | Built for this (signed URLs, Mumbai region), but like S3 it charges per GB downloaded. |
| Backblaze B2 | About half R2's storage price, but US/EU regions only. A candidate for a later disaster-recovery copy. |
| **Cloudflare R2** | **Chosen.** Free downloads, APAC placement, S3 API. Designed for 99.999999999% durability across several data centers, so file bytes need no separate backup. The Postgres database still does (§11). |

---

## 1. Architecture

```
                 ┌──────────────────────── shared EC2 box ─────────────────────────┐
  KMM app ──────▶│ nginx ─▶ app     Express 5: /api/v1, /config, legal, /s/:token, │
   │  JSON/HTTPS │          │       /webhooks/*, /admin                            │
   │             │          │                                                      │
   │             │        worker   scheduled jobs + outbox (same image)            │
   │             │          │                                                      │
   │             │        Postgres (host)  metadata · storage log · ledger         │
   │             └──────────┼────────────────────┬───────────────────┬────────────┘
   │                        │ S3 API             │ REST + webhooks    │
   │  presigned URLs        ▼                    ▼                    ▼
   └──────────────────▶ Cloudflare R2      Razorpay · RevenueCat   FCM push · SES email
     (file bytes only)  private bucket     Play Developer API
```

Four rules shape everything else:

1. **File bytes never pass through our server.** The app uploads to R2 and downloads from it directly, using
   short-lived presigned URLs. The API only handles metadata, permissions, metering and billing. That keeps
   a small EC2 box viable.
2. **Every change to stored bytes goes through one function.** Uploads, replacements, purges and account
   deletion all call `metering.recordStorageChange()` inside the same DB transaction as the metadata change.
   It appends a `StorageEvent`. Bills are computed from that append-only log, so they can be recomputed and
   audited at any time.
3. **Money is computed only on the server**, using protocol 04's money rules: paise in `BigInt`,
   `decimal.js`, half-up rounding, strings on the wire. The app shows the strings it receives.
4. **Everything retries safely.** The app generates UUIDs for folders, files and uploads. Every billing row
   has a unique key. Webhooks are de-duplicated by event id.

---

## 2. House protocols: followed and deviated

**Followed as-is:**
- The `{ success, data }` / `{ success:false, message, code }` envelope, with `AppError` subclasses and one
  error handler.
- Layering: route → controller → service → repository. Prisma is used only in repositories.
- One file per external SDK.
- `config/env.ts` is the only reader of `process.env`, and the app fails fast on bad config. Optional
  integrations need all of their keys or none; with none, their endpoints return 503.
- A foreign or missing row returns 404, never 403.
- Client UUIDs, idempotent by `(userId, id)`.
- Soft-delete tombstones.
- Money rules (as in Billanta's `MONEY.md`).
- `tsc --noEmit` plus `check:*` scripts.
- `GET /config` (protocol 10), legal pages (protocol 12) and the contract folder (protocol 01).
- Docker and compose with a separate `migrate` service, and the deploy runbook (protocol 05).
- Momentica's in-memory rate limiter.

**Deviations (protocol 04 asks for a written reason):**

| # | House default | BrimBox | Reason |
|---|---|---|---|
| D1 | Access JWT never expires; no refresh tokens | 1-hour access JWT, plus a rotating refresh token for each device (Billanta's `auth.service.ts` pattern). Supports "sign out other devices" and bans. | Protocol 04 itself says to reinstate expiry for payment and sensitive surfaces. BrimBox holds private files and a mandate on the user's bank account. The KMM client's Ktor `Auth` plugin refreshes silently, so users never see a timed logout. |
| D2 | S3 `<app>-media`, public-read; multer + sharp inside the request; 8 MB cap | R2 private bucket. Presigned direct upload and download, multipart for large files. Originals are stored byte-for-byte. | Files are the product: up to GBs, private, and never re-encoded. Proxying them would saturate the shared box. S3's download fees would dominate a pay-as-you-use price. |
| D3 | The server makes thumbnails with sharp | The app makes a ≤512 px WebP thumbnail and uploads it alongside the file | Keeps CPU and RAM off the shared box. The phone already decodes HEIF and video. |
| D4 | The sync cursor is the client's `updatedAt` | Client UUIDs, tombstones and last-write-wins on client `updatedAt` stay as in protocol 04. The *cursor* is a sequence number the server assigns per user. | Many changes start on the server: upload completion, trash auto-purge, takedowns. Device clocks also drift. A server sequence never skips a change. |
| D5 | Scheduled scripts run from the host crontab | A long-running `worker` service with a small scheduler, Postgres advisory locks and a `JobRun` table | There are about 10 recurring jobs, some every minute. Billing jobs must run exactly once and be observable. One container is lighter than cron starting a container per run. |
| D6 | RevenueCat is the only payment provider | Razorpay recurring (the mandate) plus RevenueCat (Play credit packs) | The chosen billing model needs mandates, and Play policy needs Play billing offered alongside it (§7.6). |
| D7 | No push or email infrastructure | FCM (`firebase-admin`) and Amazon SES (`@aws-sdk/client-sesv2`), each behind one file | Billing alerts must reach users who don't open the app: cap reached, bill due, suspension and deletion warnings. |

---

## 3. Codebase layout (Billanta/Curiously style)

```
src/
  app.ts                      HTTP entry
  worker.ts                   job runner entry (same image, different command)
  config/env.ts               the only reader of process.env
  common/                     errors, response, validation, pagination, rateLimit,
                              auth middleware, money.ts, bytes.ts, time.ts (IST helpers)
  storage/r2Storage.ts        sole importer of @aws-sdk/client-s3 + s3-request-presigner
  integrations/               razorpay.ts · revenueCat.ts · googleVerifier.ts ·
                              playExternalTx.ts · fcm.ts · ses.ts   (one SDK each)
  modules/
    auth/ users/ nodes/ uploads/ downloads/ sync/ shares/
    metering/ billing/ payments/ notifications/
    remoteConfig/ legal/ admin/ jobs/
      <module>.routes.ts + controller/ service/ repository/ dto/
  scripts/check-*.ts          check:metering, check:statement, check:money, check:tree, …
prisma/schema.prisma
docs/                         ARCHITECTURE.md, MONEY.md (metering + billing rules), API.md,
                              REMOTE_CONFIG.md, DEPLOY.md
```

---

## 4. Data model (Prisma sketch)

```prisma
model User {
  id          String    @id @default(uuid()) @db.Uuid
  googleSub   String    @unique
  email       String
  name        String?
  standing    Standing  @default(GOOD)   // GOOD | PAST_DUE | SUSPENDED | DELETION_SCHEDULED | CLOSED
  storedBytes BigInt    @default(0)      // live total = last StorageEvent.totalAfter
  syncSeq     BigInt    @default(0)      // last sync sequence handed out (D4)
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt
  deletedAt   DateTime?
}

model Session {                          // one per signed-in device (D1)
  id               String    @id @default(uuid()) @db.Uuid
  userId           String    @db.Uuid
  refreshTokenHash String    @unique     // sha256 of the opaque token; reuse ⇒ revoke session
  deviceName       String?
  platform         String
  lastUsedAt       DateTime
  expiresAt        DateTime              // sliding, e.g. 90 days
  revokedAt        DateTime?
}

model Node {                             // a file or a folder
  id          String    @id @db.Uuid     // generated by the app
  userId      String    @db.Uuid
  parentId    String?   @db.Uuid         // null = root
  kind        NodeKind                   // FOLDER | FILE
  name        String
  nameKey     String                     // NFC + lowercase: uniqueness + search
  blobId      String?   @db.Uuid         // files: current content
  size        BigInt    @default(0)
  mimeType    String?
  trashedAt   DateTime?
  trashRootId String?   @db.Uuid         // the node the user trashed (restore unit)
  deletedAt   DateTime?                  // tombstone after purge, kept 90 days for sync
  syncSeq     BigInt                     // per-user change sequence
  updatedAt   DateTime                   // client clock, last-write-wins (protocol 04)
  createdAt   DateTime  @default(now())
  @@index([userId, syncSeq])
  @@index([userId, parentId])
  // raw-SQL migration: UNIQUE (userId, parentId, nameKey) WHERE trashedAt IS NULL AND deletedAt IS NULL
  // raw-SQL migration: GIN trigram index on nameKey (pg_trgm is a trusted extension, no superuser needed)
}

model Blob {                             // one object in R2
  id        String    @id @db.Uuid
  userId    String    @db.Uuid
  bucket    String                       // lets us change bucket/provider later without a rewrite
  objectKey String    @unique            // u/{userId}/{blobId}   (never contains the file name)
  thumbKey  String?                      // t/{userId}/{blobId}.webp   (not billed)
  size      BigInt                       // from HeadObject, never from the client
  sha256    String?
  createdAt DateTime  @default(now())
  purgedAt  DateTime?
}

model UploadSession {
  id           String      @id @db.Uuid  // generated by the app → retries return the same session
  userId       String      @db.Uuid
  fileId       String      @db.Uuid      // the Node it creates or replaces
  parentId     String?     @db.Uuid
  name         String
  declaredSize BigInt
  mimeType     String
  objectKey    String      @unique       // reserved BEFORE any URL is issued → no untracked objects
  r2UploadId   String?                   // multipart only
  partSize     Int?
  state        UploadState               // PENDING | COMPLETED | ABORTED | EXPIRED | FAILED
  expiresAt    DateTime
  createdAt    DateTime    @default(now())
}

model StorageEvent {                     // append-only; the metering source of truth
  id         BigInt   @id @default(autoincrement())
  userId     String   @db.Uuid
  at         DateTime
  deltaBytes BigInt
  totalAfter BigInt
  reason     String                      // UPLOAD | REPLACE | PURGE | ACCOUNT_DELETE | ADMIN
  refId      String?
  @@index([userId, at])
}

model UsageDay {                         // one row per user per IST day
  userId           String   @db.Uuid
  day              DateTime @db.Date
  byteSeconds      Decimal  @db.Decimal(38, 0)
  endBytes         BigInt                // starting value for the next day
  peakBytes        BigInt
  downloadBytes    BigInt                // metered, not charged in v1
  chargeMicroPaise BigInt                // exact daily charge, in millionths of a paisa
  priceBookId      String   @db.Uuid
  @@id([userId, day])
}

model PriceBook {
  id                     String   @id @default(uuid()) @db.Uuid
  effectiveFrom          DateTime
  storagePaisePerGBMonth BigInt            // 250 = ₹2.50
  freeBytes              BigInt            // e.g. 2_000_000_000
  gstBasisPoints         Int               // 1800 = 18%
  minDebitPaise          BigInt            // smaller totals roll into next month
}

model BillingAccount {
  userId              String       @id @db.Uuid
  capPaise            BigInt?               // = the mandate's max_amount
  mandateState        MandateState @default(NONE)  // NONE | PENDING | ACTIVE | PAUSED | CANCELLED | REJECTED
  mandateMethod       String?               // UPI | CARD | EMANDATE
  razorpayCustomerId  String?
  razorpayTokenId     String?
  playExternalTxToken String?               // from Play's user choice screen (§7.6)
  balancePaise        BigInt       @default(0)  // + credit, − owed; = last LedgerEntry.balanceAfter
}

model Statement {                        // one per user per IST calendar month
  id             String          @id @default(uuid()) @db.Uuid
  userId         String          @db.Uuid
  periodStart    DateTime        @db.Date
  periodEnd      DateTime        @db.Date
  gbMonths       String                  // decimal string, for display
  subtotalPaise  BigInt
  gstPaise       BigInt
  carriedInPaise BigInt                  // sub-minimum amount rolled from last month
  totalPaise     BigInt
  status         StatementStatus         // OPEN | COLLECTING | PAID | PAST_DUE | CARRIED | WAIVED
  dueAt          DateTime?
  @@unique([userId, periodStart])
}

model LedgerEntry {                      // append-only money movements (AuraPix CreditTransaction pattern)
  id           String     @id @default(uuid()) @db.Uuid
  userId       String     @db.Uuid
  type         LedgerType                // STATEMENT | MANDATE_DEBIT | LINK_PAYMENT | PLAY_CREDIT | REFUND | ADJUSTMENT
  amountPaise  BigInt                    // signed
  balanceAfter BigInt
  referenceId  String
  note         String?                   // required for ADJUSTMENT
  createdAt    DateTime   @default(now())
  @@unique([userId, type, referenceId])
}

model Payment {
  id               String    @id @default(uuid()) @db.Uuid
  userId           String    @db.Uuid
  statementId      String?   @db.Uuid
  kind             String              // MANDATE_DEBIT | PAYMENT_LINK | MANDATE_AUTH | PLAY_CREDIT
  attempt          Int       @default(1)
  provider         String              // RAZORPAY | REVENUECAT
  providerRef      String?   @unique   // Razorpay order/payment id or store transaction id
  amountPaise      BigInt
  status           String              // CREATED | NOTIFIED | CAPTURED | FAILED | REFUNDED
  reportedToPlayAt DateTime?           // alternative-billing report (§7.6)
  createdAt        DateTime  @default(now())
  @@unique([statementId, kind, attempt])   // written BEFORE calling Razorpay → no double debit
}

model ShareLink {
  id         String    @id @default(uuid()) @db.Uuid
  userId     String    @db.Uuid
  nodeId     String    @db.Uuid
  tokenHash  String    @unique   // sha256 of 32 random bytes; the token itself is never stored
  expiresAt  DateTime?
  revokedAt  DateTime?
  disabledAt DateTime?           // admin takedown
  downloads  Int       @default(0)
  createdAt  DateTime  @default(now())
}

// Small supporting tables: WebhookEvent @@id([provider, eventId]) · Notification (dedupeKey @unique)
// · DeviceToken (FCM) · AbuseReport · OutboxJob (kind, payload, runAfter, attempts) · JobRun @@id([name, periodKey])
```

---

## 5. File flows

### 5.1 Upload (direct to R2, resumable)

1. `POST /api/v1/uploads` with `{ id, fileId, parentId, name, size, mimeType, sha256?, onConflict }`.
   - The server checks: standing, parent ownership, name conflict (`rename | replace | fail`), and
     `size ≤ maxFileSize`.
   - It also checks the billing gate: going past the free tier needs an active mandate or credit.
   - It writes a `PENDING` UploadSession with the object key reserved.
   - Files ≤ 16 MiB get one presigned PUT. Larger files start an R2 multipart upload and get back
     `partSize` and `partCount`.
   - Every response includes a presigned PUT for the thumbnail (≤ 256 KB WebP) and the **projected
     month-end bill**, so the app can warn before a large upload pushes the user past their cap.
2. `POST /api/v1/uploads/:id/parts { partNumbers }` returns presigned `UploadPart` URLs (1-hour TTL), up to
   50 per call. R2 requires every part except the last to be the same size, so the server fixes `partSize`
   per upload: 8 MiB, raised for very large files to stay under 10,000 parts.
3. The app PUTs the parts straight to R2, 3–4 in parallel, and keeps the ETags.
4. To resume after a network drop or app kill, the app calls `GET /api/v1/uploads/:id`. The server calls
   `ListParts`, and the app sends only the missing parts.
5. `POST /api/v1/uploads/:id/complete { parts }`:
   1. The server calls `CompleteMultipartUpload`.
   2. It calls `HeadObject`. **If the size differs from the declared size, the object is deleted** and the
      session is marked `FAILED`.
   3. One DB transaction then: creates the `Blob`, creates or updates the file `Node`, records the
      `StorageEvent` (+bytes), bumps `syncSeq`, and marks the session `COMPLETED`.

   Calling it again returns the same node.
6. `DELETE /api/v1/uploads/:id` aborts the upload. A sweeper job expires `PENDING` sessions after 24 h and
   aborts or deletes their reserved keys. An R2 lifecycle rule aborts incomplete multipart uploads after
   7 days as a backstop. Because the key is reserved in the DB before any URL is issued, the bucket never
   gets objects the DB doesn't know about. That fixes the Momentica orphan gap.

**Replace** (`onConflict=replace`, no version history in v1): the new blob becomes current. The old blob is
purged in the same transaction (−bytes), and its object is deleted through the outbox.

### 5.2 Downloads and thumbnails

- `GET /api/v1/files/:id/download` returns a presigned GET valid for 15 min. It sets
  `response-content-disposition` with the real file name, because object keys are opaque. R2 handles
  `Range` requests, so downloads resume and videos can seek.
- Folder listings embed a presigned thumbnail URL (1 h) for each file. Presigning is a local HMAC with no
  network call, so a 50-item page costs nothing extra.
- Each download URL issued adds the file size to `UsageDay.downloadBytes`, at most once per file per hour.
  This is for fair-use monitoring only; downloads are free in v1.

### 5.3 Trash, purge and object deletion

- **Trash:** sets `trashedAt` on the whole subtree with `trashRootId = id`, using a recursive CTE.
  **Trashed files still count as stored** until purged, and the app shows trash size and cost.
- **Restore:** returns the node to its original parent, or to root if that parent is gone. Name clashes
  are renamed to "name (1)".
- **Purge:** happens by user action or after 30 days in trash. It tombstones the nodes, records the
  `StorageEvent` (−bytes) and enqueues `DELETE_OBJECT` outbox jobs. The user stops paying at the moment of
  purge, even if R2 deletion runs a minute later.
- **Move:** a recursive CTE check rejects moving a folder into its own subtree. A per-user row lock
  serializes tree changes for each user.
- **Reconciliation (weekly, report-first):**
  - It lists `u/{userId}/` in R2 and compares the result with `Blob`.
  - It checks that `User.storedBytes` equals the sum of unpurged blob sizes and the last
    `StorageEvent.totalAfter`.
  - Any drift raises an alert.

### 5.4 Sync feed (for the app's Room cache)

`GET /api/v1/sync/changes?cursor=&limit=500` returns `{ changes, nextCursor, hasMore }`.
- Each change is a full node snapshot, including tombstones.
- The cursor is the per-user `syncSeq`. It is assigned under the user's row lock, so commit order matches
  sequence order.
- Tombstones are kept for 90 days. An older cursor gets `410 RESYNC_REQUIRED`, and the app does a full
  listing.

### 5.5 Share links (v1)

- `POST /api/v1/shares { nodeId, expiresIn, allowDownload }` returns `https://brimbox.ferbotz.com/s/<token>`.
  - The token is 32 random bytes, and only its sha256 is stored (Momentica's opaque-token rule).
  - Links expire after 7 days by default. The owner can revoke them, and admins can disable them.
- The public routes are mounted at root and need no auth:
  - `GET /s/:token` serves a self-contained HTML page (like the legal pages) with `X-Robots-Tag: noindex`.
    Link-preview crawlers get a minimal page and are never redirected (Curiously's rule).
  - `GET /s/:token/items` lists a shared folder.
  - `GET /s/:token/download[/:fileId]` returns a **302** to a presigned URL valid for 5 minutes.
  - `POST /s/:token/report` files an abuse report.
- `/.well-known/assetlinks.json` (it must return 200 JSON) lets Android open links in the app.
- Every access checks the link's state, the owner's standing (links stop when SUSPENDED) and the rate
  limits (per IP and per link, plus a daily download cap per link).
- Curiously deliberately didn't ship private-content share tokens before a privacy review, so **a privacy
  review is an exit criterion for this feature** (§12).

---

## 6. Metering: how pay-as-you-use is measured

**What is billed:** every file the user has, *including files in Trash*, from the moment its upload
completes until it is purged.

**Not billed:** thumbnails, unfinished uploads and metadata.

**1 GB = 10⁹ bytes**, the same unit Android and iOS use to show file sizes.

Storage is a step function over time. Every change writes a `StorageEvent` (`delta`, `totalAfter`, `at`)
under the user's lock. The **daily close** (00:10 IST, so in-flight transactions have committed)
integrates that function:

```
byteSeconds(day) = Σ over the day's intervals of  storedBytes × seconds
chargeable       = max(0, byteSeconds − freeBytes × 86,400)
charge(day)      = chargeable ÷ (10⁹ × 86,400) × pricePerGBMonth ÷ daysInThisMonth
```

The exact charge is kept in micro-paise (`BigInt`), and the statement rounds once (half-up). Pricing per
day of the actual month means flat usage costs exactly the advertised monthly price in every month.

**Worked example** (₹2.50/GB-month, 2 GB free, 30-day month). A user stores 10 GB for 20 days, then 30 GB
for 10 days:

| Step | Amount |
|---|---|
| Total usage (10 × 20 + 30 × 10) | 500 GB-days |
| Minus the free tier (2 GB × 30 days) | 440 GB-days ≈ 14.67 GB-months |
| Storage charge | ₹36.67 |
| GST at 18% | ₹6.60 |
| Total, auto-debited because it is under a ₹100 cap | **₹43.27** |

`check:metering` pins this example and the edge cases, as Billanta's `check:money` does:
- uploads at 23:59
- a purge in the middle of the day
- a price change at the start of a month
- a 31-day month
- usage at the free-tier boundary
- a day with no events

**Live numbers:**
- **Month-to-date** = closed days + today so far, computed from the live counter.
- **Projection** = month-to-date + current bytes × remaining time × rate.

Both are served by `GET /api/v1/billing/summary` and drive the cap alerts.

**Downloads** are metered (`UsageDay.downloadBytes`) but free, because R2 charges nothing for downloads. A
fair-use price (e.g. above 3× stored) can be added later without a schema change.

---

## 7. Billing: the capped mandate

### 7.1 Pricing and unit economics

`PriceBook` rows are versioned by `effectiveFrom`. A price change applies from the next cycle, announced at
least 30 days ahead (stated in the Terms). Example numbers, all to be decided (§13):

| Per GB-month | Amount |
|---|---|
| R2 storage cost | $0.015 ≈ ₹1.3 (at ~₹88/$) |
| Example price | ₹2.50 + 18% GST |
| Fees on the mandate path: Razorpay (~2%, confirm UPI AutoPay pricing) + Google's alternative-billing fee (~11%, §7.6) | ≈ ₹0.33 |
| **Gross margin before operations** | **≈ ₹0.87 (≈35%)** |

R2 operation fees ($4.50 per million writes, $0.36 per million reads) are negligible at these file sizes.
Per-user upload rate limits stop anyone from running them up.

### 7.2 Cycle and statement

- The billing cycle is the **calendar month in IST** (`Asia/Kolkata`, a fixed +05:30 offset). All
  timestamps are stored in UTC, and day boundaries are computed in `time.ts`.
- On the 1st at 00:30 IST, each user's statement closes:
  - `subtotal = round_half_up(Σ daily micro-paise)`
  - `GST = round_half_up(subtotal × 18%)`
  - `total = subtotal + GST + carriedIn`
- A `STATEMENT −total` ledger entry is written.
- If the total is below the minimum debit (e.g. ₹10), the statement is `CARRIED` into next month instead of
  debited.

### 7.3 Mandate setup and cap changes

- The free tier works without a mandate. To store more, the user picks a **monthly cap**: ₹100 by default,
  with presets and a custom amount.
  1. The app calls `POST /api/v1/billing/mandate { capPaise, method, externalTransactionToken }`.
  2. The backend creates a Razorpay customer (once) and a **registration link**: UPI AutoPay, card or
     eNACH, with `max_amount = cap`, `frequency = as_presented` and a long expiry.
  3. The app opens the link, and the user approves it with their UPI PIN or card.
  4. A `token.confirmed` webhook arrives. The backend re-fetches the token from Razorpay before marking the
     mandate `ACTIVE`.
- If registration needs a small first payment, it is credited to the ledger, not refunded.
- **Changing the cap** creates a new mandate. The old one is cancelled through the API only after the new
  one is confirmed.
- **The user cancels or pauses the mandate in their UPI app:** the webhook updates the state. Uploads past
  the free tier stop, and the current month is collected by payment link (§7.5).

### 7.4 Alerts (what you asked for)

| Trigger | Channel | Sent |
|---|---|---|
| Projected month-end total > cap | push | once per cycle |
| Month-to-date ≥ 80% of cap | push + email | once per cycle |
| **Month-to-date ≥ 100% of cap** ("you've passed your ₹100 limit") | push + email | once per cycle |
| An upload would push the projection over the cap | in-app (upload API returns the projection) | per upload |
| Bill ready: amount and debit date | push + email | per statement |
| Debit succeeded or failed; payment link sent | push + email | per payment |

Each notification is de-duplicated by `Notification.dedupeKey` (e.g. `cap100:{userId}:2026-10`). Reaching
the cap **only notifies; uploads keep working**, as requested. A "stop uploads at my cap" switch can be
added later.

### 7.5 Settlement, excess and failures

After the statement closes:

1. Any positive balance (Play credits) is applied first.
2. **Amount owed ≤ cap:** one mandate debit for the actual amount. The user's bank or UPI app sends the
   pre-debit notice at least 24 h ahead, as RBI rules require. The money lands about 1–2 days later.
3. **Amount owed > cap:** the cap is debited. A **payment link** (UPI/card) goes out for the excess, due in
   7 days, with a "raise my cap" prompt.
4. **No active mandate:** a payment link for the full amount.
5. **A debit fails:** it is retried once after 3 days, then a payment link is sent. The account becomes
   PAST_DUE at the due date.

Each `Payment` row is written before Razorpay is called, keyed by statement + attempt, so a crash or retry
never debits twice. Before a webhook marks a statement paid, the backend re-fetches the payment from
Razorpay (Momentica's verify-with-the-provider pattern). Webhook effects only ever move state forward.

### 7.6 Google Play compliance (must be in place before charging Play users)

Google Play's Payments policy names **data storage services** as something that must use Play's billing.
In India, Play's **user choice billing** lets an app offer its own billing *alongside* Play's.

The app shows Google's choice screen with two options:
- **"Google Play"**: prepaid credit packs (consumables via RevenueCat, house pattern). They are credited to
  the same ledger and used up by statements before the mandate is charged.
- **"UPI AutoPay / card"**: the mandate.

On mandate payments, Google charges its normal service fee minus 4 percentage points (about 11% at Play's
15% tier). Each mandate payment must be reported to Google through the Play Developer API. That means one
integration file (`playExternalTx.ts`) and a reporting job.

Billing only through a website is not a workable alternative: outside this program, the app may not link
or point users to it. Without user choice billing enrollment, the only compliant option is Play credits on
their own.

*Risk to check early:* whether RevenueCat's KMP SDK supports the user-choice screen. If it doesn't, the app
uses Play Billing Library directly for that screen.

### 7.7 Account standing

| Standing | Enters when | Upload | Download | Share links |
|---|---|---|---|---|
| GOOD | default; after any outstanding amount is paid | ✓ (past the free tier only with a mandate or credit) | ✓ | ✓ |
| PAST_DUE | a statement is unpaid at its due date | ✗ | ✓ | ✓ |
| SUSPENDED | PAST_DUE for 15 days | ✗ | ✓ so users can retrieve their data | ✗ |
| DELETION_SCHEDULED | SUSPENDED for 30 days; warnings at T-14, T-7 and T-1 | ✗ | ✗ | ✗ |
| CLOSED | data purged, or the account was deleted | — | — | — |

Paying the outstanding amount returns the account to GOOD from any state before deletion. The window
lengths are constants that the legal pages quote (protocol 12).

### 7.8 GST and invoices

Statements show GST. If BrimBox is GST-registered, it issues tax invoices. The place of supply needs the
user's state, collected at mandate setup. The CGST/SGST vs IGST split is worked out at display time
(Billanta's `MONEY.md`). **Confirm the treatment with a CA before launch.**

### 7.9 Account deletion (required in-app and on the web by Play)

1. A final statement is made for the partial month. It is collected, or waived if it is below the minimum
   debit.
2. The mandate is **cancelled through the Razorpay API**.
3. Blobs are purged through the outbox, and personal data is deleted.
4. Statements and payment records are kept for the legally required period.
5. Unused Play credits are forfeited (stated in the Terms).

`/delete-account` explains all of this (protocol 12).

---

## 8. API surface (`/api/v1` unless marked *root*)

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/google {idToken, device}` → access + refresh · `POST /auth/refresh` (rotation; a reused token revokes that session) · `POST /auth/logout` |
| Account | `GET /me` · `GET /me/sessions` · `DELETE /me/sessions/:id` · `POST /me/sessions/revoke-others` · `PUT /me/push-token` · `DELETE /me {idToken}` (needs a fresh Google sign-in). `PATCH /me` waits until there is an editable field (the GST state, P5). |
| Tree | `GET /folders/:id/children` (`root` or a UUID; cursor, limit, sort) · `POST /folders {id,parentId,name}` · `GET /nodes/:id` · `PATCH /nodes/:id {name?,parentId?,updatedAt}` · `POST /nodes/:id/trash` · `POST /nodes/:id/restore` · `DELETE /nodes/:id` (purge) · `GET /trash` · `DELETE /trash` · `GET /search?q=` |
| Sync | `GET /sync/changes?cursor&limit` |
| Uploads | `POST /uploads` · `POST /uploads/:id/parts` · `GET /uploads/:id` · `POST /uploads/:id/complete` · `DELETE /uploads/:id` |
| Downloads | `GET /files/:id/download` → `{url, expiresAt}` |
| Sharing | `POST /shares` · `GET /shares` · `DELETE /shares/:id` · *root:* `GET /s/:token`, `GET /s/:token/items`, `GET /s/:token/download[/:fileId]`, `POST /s/:token/report` |
| Billing | `GET /billing/summary` (standing, stored bytes, month-to-date, projection, cap, mandate, balance, outstanding) · `GET /billing/usage?from&to` · `GET /billing/statements[/:id]` · `POST /billing/mandate` · `DELETE /billing/mandate` · `POST /billing/statements/:id/pay` → payment link · `POST /billing/credits/verify {storeTransactionId}` |
| Platform (*root*) | `GET /` (health) · `GET /config` · `GET /privacy` `/terms` `/delete-account` · `POST /webhooks/razorpay` · `POST /webhooks/revenuecat` · `GET /.well-known/assetlinks.json` · `/admin` |

**Contract conventions** (for the protocol 01 contract folder):
- Money is a decimal string of paise.
- Sizes are JSON numbers of bytes.
- IDs for folders, files and uploads are UUIDs generated by the app.
- Timestamps are ISO-8601 UTC. Billing days and months are in IST.
- The sync cursor is an opaque string.

---

## 9. Background jobs (the `worker` service)

| Job | Schedule (IST) | What makes it safe to re-run |
|---|---|---|
| `metering.closeDay` | daily 00:10 | `UsageDay` primary key `(userId, day)` |
| `billing.closeCycle` | 1st of the month, 00:30 | `Statement` unique `(userId, periodStart)` |
| `billing.settle` | after closeCycle, then hourly | `Payment` unique `(statementId, kind, attempt)` |
| `billing.alerts` | hourly | `Notification.dedupeKey` |
| `billing.standing` | daily 09:00 | dated, forward-only transitions |
| `payments.reconcile` | daily | re-fetches non-final payments from Razorpay |
| `play.reportExternalTx` | every 15 min | `Payment.reportedToPlayAt` |
| `uploads.sweep` | every 15 min | upload session state machine |
| `outbox.drain` | every minute | `FOR UPDATE SKIP LOCKED`, retries with backoff |
| `trash.autoPurge` | daily 03:00 | node state |
| `reconcile.storage` | weekly | report-only; quarantines orphans |

Every job takes a Postgres advisory lock and writes a `JobRun` row keyed by `(name, periodKey)`. A missed
or failed run is visible and alertable. The nightly DB backup runs from the host cron, not the worker
(§11).

---

## 10. Security and abuse

- **The bucket is private.** The R2 API token is scoped to this one bucket. Keys go in the server `.env`
  and the credentials registry (protocol 00).
- **Presigned URL lifetimes:** upload parts 1 h, downloads 15 min, thumbnails 1 h, share downloads 5 min.
  Object keys never contain file names.
- **No client-declared number is trusted.** Sizes are checked with `HeadObject`, and every price and amount
  is computed on the server.
- **Webhooks:**
  - Razorpay is verified by HMAC-SHA256 of the raw body (`X-Razorpay-Signature`).
  - RevenueCat is verified by its shared secret, compared in constant time.
  - Both are de-duplicated by event id and return 200 for events we ignore.
  - Unknown product ids are rejected and logged, never silently ignored (the AuraPix lesson).
- **Rate limits** (Momentica's limiter) apply to sign-in, upload start, share access and abuse reports.
- **Logs never contain** tokens, presigned URLs or file names.
- **Admin:** access uses `ADMIN_API_KEY` (house pattern). Every money correction is a `LedgerEntry` of type
  `ADJUSTMENT` with a required note.
- **Abuse:**
  - The Terms include an acceptable-use section.
  - Share links have a report flow, an admin takedown, and a per-user switch to disable sharing.
  - Hash-based scanning of shared content is a later option.

---

## 11. Infrastructure, deploy and backups

- **Following protocols 03 and 05:**
  - Compose project `name: brimbox`, with `app` on `127.0.0.1:8094`. Ports 8080 and 8090–8093 are taken;
    re-check on the box.
  - Services: `app`, `worker` (same image, `node dist/worker.js`), and `migrate` under the `tools` profile.
  - A `brimbox` database and role on the host Postgres.
  - An nginx vhost and a certbot certificate for `brimbox.ferbotz.com`.
- **R2:** bucket `brimbox-files` with the APAC location hint, private, and a lifecycle rule that aborts
  incomplete multipart uploads after 7 days.
- **Box capacity:** BrimBox would be the **5th app** on the t3.micro (~1 GB RAM). Momentica's `DEPLOY.md`
  says to move to a larger instance at that point. Resize to at least a t3.small before launch. That needs a
  stop/start of the shared box, so it is your call.
- **Backups:** protocol 08 isn't written yet, but BrimBox can't launch without backups. Object keys are
  opaque, so **losing the database would lose every user's file tree**. The plan:
  - a nightly `pg_dump` to a private bucket, kept for 30 days
  - a restore test every month
  - owner and file ids written into each R2 object's metadata, as a last-resort recovery path
- **Steps you run** (protocol 02 boundary, plus the new vendors). Claude prepares exact instructions for
  each:
  - Cloudflare account, bucket and scoped token
  - Razorpay KYC, recurring-payments activation and webhook secret
  - Play Console user choice billing enrollment and a service account
  - Firebase project
  - SES domain verification (DNS)
  - box resize

---

## 12. Roadmap

| Phase | Scope | Exit criteria |
|---|---|---|
| **P0 Foundations** | Protocol 00 setup: Drive folder, contract folder, docs mirror; the details doc and credentials registry entries are written at first deploy, when there are secrets to record. Scaffold per protocol 04, `/config`, legal pages, health, Docker/compose, `CLAUDE.md`. DNS, vhost, TLS. The R2 bucket is created by you, ready for P3. | `https://brimbox.ferbotz.com` serves health, `/config` and the legal pages. Contract folder bootstrapped. |
| **P1 Accounts** | Database and role on the host Postgres, Prisma and the `migrate` service (moved here from P0 because nothing reads a database before P1). Google sign-in, access + refresh sessions (D1), session list/revoke, push-token registration, account-deletion skeleton. | `check:auth` (pure) and `check:auth-db` (local database) pass: rotation, the lost-response retry window, reuse detection, idle expiry, revoke-others, re-auth for deletion. **Built, checked and deployed 2026-10-01** (sign-in waits on the Google OAuth client). |
| **P2 Tree + sync** | Folders and files metadata, rename/move, trash/restore/purge, search, sync feed | `check:tree` (cycles, name conflicts, restore clashes) and `check:sync` pass |
| **P3 Data plane** | Upload sessions (single + multipart, resume), complete + verify, thumbnails, downloads, outbox deletes, sweeper, reconciliation, `StorageEvent` choke point | A 5 GB upload survives network drops and an app kill. `check:storage` invariants hold. |
| **P4 Metering + statements** | Daily close, PriceBook, month-to-date and projection, monthly statements, FCM + SES, cap alerts | The `check:metering` worked examples match. Re-running a close changes nothing. Alerts fire once per cycle. |
| **P5 Mandate billing** | Razorpay customer + mandate, webhooks, settlement (≤ cap, excess link, retry), standing state machine, cap change, cancellation, deletion → cancel mandate | Full cycle in Razorpay test mode, including replayed webhooks and a crash between "Payment row written" and "Razorpay called". `check:settlement` passes. |
| **P6 Play compliance** | User choice billing enrollment, Play credit packs via RevenueCat into the ledger, alternative-billing reporting | Credits are used before the mandate. Each mandate payment is reported to Google. |
| **P7 Share links** | Links, public page, App Links, limits, abuse reports, admin takedown | Privacy review signed off. Rate limits verified. |
| **P8 Launch hardening** | Admin panel (users, statements, adjustments, takedowns), backups + restore test, job and webhook alerts, load test, final legal text, store listing URLs | Every item on the protocol 00 "done when" list is checked. |

P7 can run in parallel with P4–P6. Internal testing can start after P3 using the free tier only. Charging
real users needs P5 **and** P6.

---

## 13. Open decisions (suggested defaults)

1. **Price and free tier:** ₹2.50/GB-month + GST above 2 GB free.
2. **Cap presets:** ₹100 (default), ₹250, ₹500, ₹1,000, or custom.
3. **Over the cap:** debit the cap and send a payment link for the rest, due in 7 days. The alternative is
   to block uploads at the cap.
4. **Grace windows:** PAST_DUE at the due date → SUSPENDED after 15 days → deletion after 30 more days.
   Also decide whether storage keeps accruing charges while SUSPENDED. Suggested: stop, so the way back
   stays affordable.
5. **Minimum debit:** ₹10. Smaller totals carry into next month.
6. **Business setup before P5 goes live:** legal entity, GST registration, Razorpay recurring activation.
7. **Play side before P6:** credit pack sizes and user choice billing enrollment.
8. **Shared box:** resize the t3.micro or give BrimBox its own instance.
9. **Max file size in v1:** 10 GB, set through `/config`.

---

## 14. Sources

- Cloudflare R2 pricing (2026): https://www.bucketmate.app/blogs/cloudflare-r2-pricing-2026
- Backblaze B2 pricing: https://www.backblaze.com/cloud-storage/pricing
- AWS S3 pricing, Mumbai (2026): https://precisiontech.in/cloud/amazon-aws-cloud/aws-pricing/aws-pricing-in-mumbai/
- Google Play Payments policy (data storage named): https://support.google.com/googleplay/android-developer/answer/10281818?hl=en
- Google Play billing changes for India (user choice billing): https://support.google.com/googleplay/android-developer/answer/13306652?hl=en-IN
- Understanding user choice billing: https://support.google.com/googleplay/android-developer/answer/13821247?hl=en
- Razorpay recurring payments for UPI (`max_amount`, `as_presented`): https://razorpay.com/docs/payments/recurring-payments/upi/apis/
