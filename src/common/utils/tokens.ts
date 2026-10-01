import crypto from "crypto";
import jwt, { JsonWebTokenError, TokenExpiredError } from "jsonwebtoken";

// The ONLY file that imports jsonwebtoken (HOA protocol 04: each SDK behind one file). Pure — no
// config import — so the check:auth script can exercise it with its own secret and clock; the
// configured instance lives in modules/auth/auth.tokens.ts.

// What an access token proves: this user, through this signed-in session (device).
export interface AccessTokenClaims {
  userId: string;
  sessionId: string;
}

export interface SignedAccessToken {
  token: string;
  // Lifetime in seconds, so the app can refresh before expiry instead of waiting for a 401.
  expiresIn: number;
}

// HS256 pinned on both sides: verification never lets the token choose its own algorithm.
const ALGORITHM = "HS256" as const;

export const createAccessTokenSigner = (secret: string, ttlSeconds: number) => ({
  sign(claims: AccessTokenClaims, nowMs = Date.now()): SignedAccessToken {
    // `iat` comes from the caller's clock, and jsonwebtoken computes `exp` from it, so a test
    // clock controls both.
    const token = jwt.sign(
      { sub: claims.userId, sid: claims.sessionId, iat: Math.floor(nowMs / 1000) },
      secret,
      { algorithm: ALGORITHM, expiresIn: ttlSeconds }
    );
    return { token, expiresIn: ttlSeconds };
  },

  // Throws on a bad signature, a malformed token, an expired token, or missing claims.
  verify(token: string, nowMs = Date.now()): AccessTokenClaims {
    const payload = jwt.verify(token, secret, {
      algorithms: [ALGORITHM],
      clockTimestamp: Math.floor(nowMs / 1000),
    });
    if (typeof payload !== "object" || payload === null) {
      throw new JsonWebTokenError("jwt payload is not an object");
    }
    const { sub, sid } = payload as { sub?: unknown; sid?: unknown };
    if (typeof sub !== "string" || typeof sid !== "string") {
      throw new JsonWebTokenError("jwt is missing sub/sid claims");
    }
    return { userId: sub, sessionId: sid };
  },
});

export type AccessTokenSigner = ReturnType<typeof createAccessTokenSigner>;

// A short, loggable reason a token was rejected ("invalid signature", "jwt expired at …"). The
// 401 the client sees stays opaque, but the reason is logged: an opaque 401 that logs nothing is
// undiagnosable in production. It never includes the token itself.
export const tokenRejectionReason = (err: unknown): string => {
  // Checked before JsonWebTokenError — TokenExpiredError extends it.
  if (err instanceof TokenExpiredError) {
    return `jwt expired at ${err.expiredAt.toISOString()}`;
  }
  if (err instanceof JsonWebTokenError) {
    return err.message;
  }
  return err instanceof Error ? err.message : "unknown error";
};

// A refresh token: 256 bits of CSPRNG output, base64url (43 characters). Returned to the app once
// and never stored — only its hash is.
export const generateRefreshToken = (): string => crypto.randomBytes(32).toString("base64url");

// SHA-256 (hex) of an opaque token. A fast hash is correct for 256-bit random tokens: there is no
// guessable input to slow down, and verification is a unique-index lookup.
export const hashToken = (raw: string): string =>
  crypto.createHash("sha256").update(raw, "utf8").digest("hex");
