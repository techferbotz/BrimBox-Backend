import {
  LAST_USED_WRITE_INTERVAL_SECONDS,
  REAUTH_MAX_AGE_SECONDS,
  REFRESH_RETRY_GRACE_SECONDS,
  REFRESH_TOKEN_IDLE_DAYS,
} from "./auth.policy";

// Pure decisions behind sign-in and sessions — no database, no clock of their own — so check:auth
// can pin every branch.

/** The parts of a session a refresh decision needs. */
export interface RefreshCandidate {
  id: string;
  userId: string;
  expiresAt: Date;
  rotatedAt: Date | null;
}

export type RefreshDecision =
  | { kind: "rotate"; sessionId: string; userId: string } // the current token: normal rotation
  | { kind: "retry"; sessionId: string; userId: string } // the replaced token, inside the grace window
  | { kind: "reuse"; sessionId: string; userId: string } // the replaced token, after it: theft
  | { kind: "expired"; sessionId: string; userId: string } // the session idled out
  | { kind: "unknown" }; // not a token we know (forged, older, or already signed out)

/**
 * Decide what a presented refresh token means. `byCurrent` is the session whose CURRENT token
 * hash matches; `byPrevious` is the session whose REPLACED token hash matches (at most one of the
 * two is set: hashes are unique).
 */
export const decideRefresh = (
  byCurrent: RefreshCandidate | null,
  byPrevious: RefreshCandidate | null,
  now: Date,
  graceSeconds = REFRESH_RETRY_GRACE_SECONDS
): RefreshDecision => {
  const session = byCurrent ?? byPrevious;
  if (!session) return { kind: "unknown" };
  const ids = { sessionId: session.id, userId: session.userId };

  if (session.expiresAt.getTime() <= now.getTime()) return { kind: "expired", ...ids };
  if (byCurrent) return { kind: "rotate", ...ids };

  const rotatedAt = session.rotatedAt?.getTime();
  const withinGrace =
    rotatedAt !== undefined && now.getTime() - rotatedAt <= graceSeconds * 1000;
  return withinGrace ? { kind: "retry", ...ids } : { kind: "reuse", ...ids };
};

/** When a session last used now should expire if it's never used again. */
export const sessionIdleExpiry = (now: Date): Date =>
  new Date(now.getTime() + REFRESH_TOKEN_IDLE_DAYS * 24 * 60 * 60 * 1000);

export type ReauthCheck = { ok: true } | { ok: false; reason: "mismatch" | "stale" };

/**
 * Destructive actions need the owner to be present: a Google sign-in for the SAME account (same
 * `sub`), made within the last few minutes (`iat`). A stolen access token alone can't pass this.
 */
export const checkReauth = (
  identity: { sub: string; issuedAt: number },
  accountSub: string | null,
  now: Date,
  maxAgeSeconds = REAUTH_MAX_AGE_SECONDS
): ReauthCheck => {
  if (accountSub === null || identity.sub !== accountSub) return { ok: false, reason: "mismatch" };
  const ageSeconds = now.getTime() / 1000 - identity.issuedAt;
  return ageSeconds > maxAgeSeconds ? { ok: false, reason: "stale" } : { ok: true };
};

/** Whether an authenticated request should update `Session.lastUsedAt`. */
export const shouldTouchLastUsed = (
  lastUsedAt: Date,
  now: Date,
  intervalSeconds = LAST_USED_WRITE_INTERVAL_SECONDS
): boolean => now.getTime() - lastUsedAt.getTime() >= intervalSeconds * 1000;
