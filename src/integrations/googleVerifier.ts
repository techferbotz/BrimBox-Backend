import { OAuth2Client, TokenPayload } from "google-auth-library";
import { config } from "../config/env";
import { ServiceUnavailableError, UnauthorizedError } from "../common/errors/AppError";

// The ONLY file that imports google-auth-library (HOA protocol 04). Everything above this boundary
// deals in a plain GoogleIdentity, so Sign in with Apple (the iOS release) is a sibling verifier,
// not a change to the auth service.

// An identity we have PROVEN belongs to the caller, by verifying Google's signature.
export interface GoogleIdentity {
  sub: string; // Google's stable account id — the identity key
  email: string;
  name: string | null;
  photoUrl: string | null;
  issuedAt: number; // the idToken's `iat`, in seconds — how recently the user actually signed in
}

export type VerifyGoogleIdToken = (idToken: string) => Promise<GoogleIdentity>;

// Pure half: turn a VERIFIED payload into an identity, or reject it. Exported for check:auth.
export const identityFromPayload = (payload: TokenPayload | undefined): GoogleIdentity => {
  if (!payload || !payload.sub || typeof payload.iat !== "number") {
    throw new UnauthorizedError("Google sign-in could not be verified", "INVALID_ID_TOKEN");
  }
  // Real Google sign-ins always carry a verified email; anything else is not a sign-in we accept.
  if (!payload.email || payload.email_verified !== true) {
    throw new UnauthorizedError(
      "This Google account has no verified email address",
      "INVALID_ID_TOKEN"
    );
  }
  return {
    sub: payload.sub,
    email: payload.email,
    name: payload.name?.trim() || null,
    photoUrl: payload.picture ?? null,
    issuedAt: payload.iat,
  };
};

/**
 * Verify a Google idToken SERVER-SIDE and return the identity it attests to.
 *
 * The most security-critical function in the app. An idToken is a signed JWT the client hands us;
 * without checking it, anyone could claim to be anyone. `verifyIdToken` checks Google's
 * SIGNATURE, `iss` and `exp`; `audience` pins `aud` to OUR client id(s), so a token minted for a
 * different app (which an attacker can legitimately obtain) is rejected. Nothing from the request
 * body is trusted — every field comes out of the verified payload.
 */
export const createGoogleVerifier = (clientIds: string[]): VerifyGoogleIdToken => {
  // One client per process: it caches Google's signing certs, so most verifications are offline.
  const client = new OAuth2Client();

  return async (idToken: string): Promise<GoogleIdentity> => {
    if (clientIds.length === 0) {
      throw new ServiceUnavailableError("Sign-in is not configured yet");
    }
    let payload: TokenPayload | undefined;
    try {
      const ticket = await client.verifyIdToken({ idToken, audience: clientIds });
      payload = ticket.getPayload();
    } catch (err) {
      // Bad signature, wrong audience, expired, malformed — the same to the caller. The reason
      // is logged (never the token), not returned.
      console.warn(`[auth] Google idToken rejected: ${(err as Error).message}`);
      throw new UnauthorizedError("Google sign-in could not be verified", "INVALID_ID_TOKEN");
    }
    return identityFromPayload(payload);
  };
};

export const verifyGoogleIdToken = createGoogleVerifier(config.googleClientIds);
