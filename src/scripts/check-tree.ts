// Fixture checks for the file tree's pure rules and the worker's schedule (HOA protocol 04: small
// ts-node scripts, no test framework). No database, no network:
//
//   npm run check:tree
//
// The database-backed flows (trash, restore, purge, sync, compaction, jobs) are check:tree-db.

import assert from "node:assert/strict";
import { BadRequestError } from "../common/errors/AppError";
import { duePeriod, istParts, mayClaim, RETRY_AFTER_FAILURE_MS, STALE_RUN_MS } from "../modules/jobs/jobs.schedule";
import { MAX_NAME_BYTES } from "../modules/nodes/nodes.policy";
import {
  availableName,
  compareFeedPosition,
  mustResync,
  decodeChildrenCursor,
  decodeNameCursor,
  decodeSyncCursor,
  decodeTrashCursor,
  encodeChildrenCursor,
  encodeNameCursor,
  encodeSyncCursor,
  encodeTrashCursor,
  escapeLike,
  nameKeyOf,
  normalizeName,
  numberingPrefixKey,
  parseLimit,
} from "../modules/nodes/nodes.rules";

let passed = 0;
const check = (name: string, fn: () => void): void => {
  try {
    fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}`);
    console.error(err);
    process.exit(1);
  }
};

const throwsCode = (fn: () => unknown, code: string): void => {
  assert.throws(fn, (e: unknown) => e instanceof BadRequestError && e.code === code);
};

const ID = "0f9e2a6c-1111-4222-8333-944455556666";

// ---------------------------------------------------------------- names
check("names: trimmed and NFC-normalised; the key is case-insensitive", () => {
  assert.deepEqual(normalizeName("  Photos  "), { name: "Photos", nameKey: "photos" });
  const decomposed = "Café"; // "Café" with a combining accent
  assert.equal(normalizeName(decomposed).name, "Café");
  assert.equal(nameKeyOf("CAFÉ"), nameKeyOf(decomposed));
  assert.equal(nameKeyOf("Photos"), nameKeyOf("PHOTOS"));
});

check("names: empty, dot names, separators, control characters and over-long names are refused", () => {
  for (const bad of ["", "   ", ".", "..", "a/b", "a\\b", "tab\there", "nul\u0000", 42, null, undefined]) {
    throwsCode(() => normalizeName(bad), "INVALID_NAME");
  }
  normalizeName("a".repeat(MAX_NAME_BYTES)); // exactly at the limit is fine
  throwsCode(() => normalizeName("a".repeat(MAX_NAME_BYTES + 1)), "INVALID_NAME");
  // The limit is in UTF-8 bytes: 128 two-byte characters is 256 bytes.
  throwsCode(() => normalizeName("é".repeat(128)), "INVALID_NAME");
  // Dots inside a name, and leading dots, are ordinary.
  assert.equal(normalizeName("...draft").name, "...draft");
});

check("names: a free name is kept; a taken one gets the first free number", () => {
  assert.equal(availableName("Photos", "FOLDER", new Set()), "Photos");
  assert.equal(availableName("Photos", "FOLDER", new Set(["photos"])), "Photos (1)");
  assert.equal(availableName("Photos", "FOLDER", new Set(["photos", "photos (1)", "photos (2)"])), "Photos (3)");
  // Taken-ness is by key: "PHOTOS (1)" blocks "Photos (1)".
  assert.equal(availableName("Photos", "FOLDER", new Set(["photos", "photos (1)"])), "Photos (2)");
});

check("names: files keep their extension last; folders and dotfiles don't split", () => {
  assert.equal(availableName("photo.jpg", "FILE", new Set(["photo.jpg"])), "photo (1).jpg");
  assert.equal(availableName("archive.tar.gz", "FILE", new Set(["archive.tar.gz"])), "archive.tar (1).gz");
  assert.equal(availableName(".env", "FILE", new Set([".env"])), ".env (1)");
  assert.equal(availableName("v1.2", "FOLDER", new Set(["v1.2"])), "v1.2 (1)");
  assert.equal(numberingPrefixKey("Photo.JPG", "FILE"), "photo");
  assert.equal(numberingPrefixKey("Photos.2024", "FOLDER"), "photos.2024");
});

check("names: a numbered name still fits the byte limit", () => {
  const long = "x".repeat(MAX_NAME_BYTES);
  const numbered = availableName(long, "FOLDER", new Set([nameKeyOf(long)]));
  assert.ok(numbered.endsWith(" (1)"));
  assert.ok(Buffer.byteLength(numbered, "utf8") <= MAX_NAME_BYTES);
});

check("search: LIKE wildcards and the escape character are matched literally", () => {
  assert.equal(escapeLike("50%"), "50\\%");
  assert.equal(escapeLike("a_b"), "a\\_b");
  assert.equal(escapeLike("back\\slash"), "back\\\\slash");
  assert.equal(escapeLike("plain"), "plain");
});

// ---------------------------------------------------------------- limits and cursors
check("limit: default when absent; whole numbers within range only", () => {
  assert.equal(parseLimit(undefined, 100, 500), 100);
  assert.equal(parseLimit("25", 100, 500), 25);
  for (const bad of ["0", "501", "-1", "2.5", "abc", ["1"], ""]) {
    assert.throws(() => parseLimit(bad, 100, 500), BadRequestError);
  }
});

check("cursors: every kind round-trips; absent is undefined", () => {
  const children = { phase: "FOLDER" as const, after: { nameKey: "photos", id: ID } };
  assert.deepEqual(decodeChildrenCursor(encodeChildrenCursor(children)), children);
  assert.deepEqual(decodeChildrenCursor(encodeChildrenCursor({ phase: "FILE", after: null })), { phase: "FILE", after: null });
  assert.deepEqual(decodeNameCursor(encodeNameCursor({ nameKey: "a", id: ID })), { nameKey: "a", id: ID });
  const t = new Date("2026-10-09T10:00:00.000Z");
  assert.deepEqual(decodeTrashCursor(encodeTrashCursor({ trashedAt: t, id: ID })), { trashedAt: t, id: ID });
  const sc = { seq: 9007199254740993n, id: ID, floor: 42n };
  assert.deepEqual(decodeSyncCursor(encodeSyncCursor(sc)), sc);
  assert.equal(decodeSyncCursor(undefined), undefined);
});

check("feed: positions order by seq then id; resync only when compaction passed an older cursor by", () => {
  const MAX = "ffffffff-ffff-ffff-ffff-ffffffffffff";
  assert.equal(compareFeedPosition({ seq: 5n, id: MAX }, { seq: 6n, id: ID }), -1);
  assert.equal(compareFeedPosition({ seq: 6n, id: ID }, { seq: 6n, id: MAX }), -1);
  assert.equal(compareFeedPosition({ seq: 6n, id: ID }, { seq: 6n, id: ID }), 0);
  // Compaction raised the floor to 8 after the cursor was issued, and the cursor is behind it: resync.
  assert.equal(mustResync({ seq: 5n, id: ID, floor: 0n }, 8n), true);
  assert.equal(mustResync({ seq: 5n, id: ID, floor: 3n }, 8n), true);
  // Issued under the current floor — a full sync walking old rows below it: fine.
  assert.equal(mustResync({ seq: 5n, id: ID, floor: 8n }, 8n), false);
  // Already past the floor: fine.
  assert.equal(mustResync({ seq: 8n, id: ID, floor: 0n }, 8n), false);
});

check("cursors: garbage, wrong shapes and wrong kinds are INVALID_CURSOR", () => {
  const garbage = ["", "not-base64!!", Buffer.from("[1,2]").toString("base64url"), Buffer.from("{}").toString("base64url"), "x".repeat(2000), 5];
  for (const raw of garbage) {
    throwsCode(() => decodeSyncCursor(raw), "INVALID_CURSOR");
    throwsCode(() => decodeChildrenCursor(raw), "INVALID_CURSOR");
  }
  // A sync cursor is not a children cursor, and vice versa.
  throwsCode(() => decodeChildrenCursor(encodeSyncCursor({ seq: 1n, id: ID, floor: 0n })), "INVALID_CURSOR");
  throwsCode(() => decodeSyncCursor(encodeNameCursor({ nameKey: "a", id: ID })), "INVALID_CURSOR");
  throwsCode(() => decodeSyncCursor(Buffer.from(JSON.stringify({ s: "-1", i: ID, f: "0" })).toString("base64url")), "INVALID_CURSOR");
  // A sync cursor without its floor is not accepted.
  throwsCode(() => decodeSyncCursor(Buffer.from(JSON.stringify({ s: "1", i: ID })).toString("base64url")), "INVALID_CURSOR");
});

// ---------------------------------------------------------------- the worker's schedule
check("schedule: IST date and minute-of-day (UTC+05:30)", () => {
  assert.deepEqual(istParts(new Date("2026-10-09T21:29:00Z")), { date: "2026-10-10", minuteOfDay: 2 * 60 + 59 });
  assert.deepEqual(istParts(new Date("2026-10-09T18:29:00Z")), { date: "2026-10-09", minuteOfDay: 23 * 60 + 59 });
});

check("schedule: a daily job is due from its IST time on, for that IST date", () => {
  assert.equal(duePeriod("03:00", new Date("2026-10-09T21:29:00Z")), null); // 02:59 IST
  assert.equal(duePeriod("03:00", new Date("2026-10-09T21:30:00Z")), "2026-10-10"); // 03:00 IST
  assert.equal(duePeriod("03:00", new Date("2026-10-10T18:00:00Z")), "2026-10-10"); // 23:30 IST, same day
  assert.throws(() => duePeriod("3am", new Date()));
});

check("schedule: claim rules — once per period, crashed runs and failures retried after a pause", () => {
  const now = new Date("2026-10-10T00:00:00Z");
  const ago = (ms: number): Date => new Date(now.getTime() - ms);
  assert.equal(mayClaim(null, now), true);
  assert.equal(mayClaim({ status: "SUCCEEDED", startedAt: ago(1000), finishedAt: ago(500) }, now), false);
  assert.equal(mayClaim({ status: "RUNNING", startedAt: ago(60_000), finishedAt: null }, now), false);
  assert.equal(mayClaim({ status: "RUNNING", startedAt: ago(STALE_RUN_MS + 1), finishedAt: null }, now), true);
  assert.equal(mayClaim({ status: "FAILED", startedAt: ago(70_000), finishedAt: ago(60_000) }, now), false);
  assert.equal(mayClaim({ status: "FAILED", startedAt: ago(RETRY_AFTER_FAILURE_MS + 2), finishedAt: ago(RETRY_AFTER_FAILURE_MS + 1) }, now), true);
});

console.log(`\ncheck:tree — ${passed} checks passed`);
