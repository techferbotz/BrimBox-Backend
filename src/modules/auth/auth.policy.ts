// Sign-in and session policy (deviation D1 in docs/BACKEND_PLAN.md). The access-token lifetime is
// an env knob (JWT_EXPIRES_IN, default 1h, in config/env.ts); everything else is fixed here.

/** A session (signed-in device) that isn't used for this long expires and must sign in again. */
export const REFRESH_TOKEN_IDLE_DAYS = 90;

/**
 * After a refresh, the token it replaced is accepted once more for this long and gets fresh tokens
 * instead of revoking the session. That covers a phone whose refresh response was lost on a flaky
 * network and which retries with the token it still holds. After the window, presenting a replaced
 * token means it was copied: the session is revoked.
 */
export const REFRESH_RETRY_GRACE_SECONDS = 60;

/** Account deletion needs a Google sign-in at most this old, proving the owner is present. */
export const REAUTH_MAX_AGE_SECONDS = 10 * 60;

/** `Session.lastUsedAt` is written at most this often, so reads don't each cost a write. */
export const LAST_USED_WRITE_INTERVAL_SECONDS = 5 * 60;
