import { UnauthorizedError } from "../../../common/errors/AppError";
import {
  AccessTokenSigner,
  generateRefreshToken,
  hashToken,
  tokenRejectionReason,
} from "../../../common/utils/tokens";
import { VerifyGoogleIdToken, verifyGoogleIdToken } from "../../../integrations/googleVerifier";
import { toUserDto } from "../../account/dto/account.dto";
import { userRepository } from "../../account/repository/user.repository";
import { decideRefresh, sessionIdleExpiry, shouldTouchLastUsed } from "../auth.rules";
import { accessTokens } from "../auth.tokens";
import { DeviceInfo, SignInResponse, TokenPairResponse } from "../dto/auth.dto";
import { sessionRepository } from "../repository/session.repository";

// Error codes the app branches on. Both mean "sign in again"; REUSED additionally means the
// session was revoked because its refresh token turned up somewhere it shouldn't have.
export const INVALID_REFRESH_TOKEN = "INVALID_REFRESH_TOKEN";
export const REFRESH_TOKEN_REUSED = "REFRESH_TOKEN_REUSED";

// Injected so check:auth-db can run the real service against a test database with a fake Google
// and a controllable clock — without any test switch in production code.
export interface AuthServiceDeps {
  verifyIdToken: VerifyGoogleIdToken;
  accessTokens: AccessTokenSigner;
  now: () => Date;
}

export interface AuthenticatedSession {
  userId: string;
  sessionId: string;
}

export class AuthService {
  constructor(private readonly deps: AuthServiceDeps) {}

  /**
   * Sign in with a Google idToken: verify it with Google FIRST (nothing in the request body is
   * trusted), resolve the account, and open a session for this device.
   */
  async signInWithGoogle(idToken: string, device: DeviceInfo): Promise<SignInResponse> {
    const identity = await this.deps.verifyIdToken(idToken);
    const now = this.deps.now();
    const { user, isNew } = await userRepository.upsertFromGoogle(identity);

    const refreshToken = generateRefreshToken();
    const session = await sessionRepository.createReplacingDevice(
      { userId: user.id, refreshTokenHash: hashToken(refreshToken), expiresAt: sessionIdleExpiry(now), ...device },
      now
    );
    const access = this.deps.accessTokens.sign({ userId: user.id, sessionId: session.id }, now.getTime());
    return {
      accessToken: access.token,
      expiresIn: access.expiresIn,
      refreshToken,
      user: toUserDto(user),
      isNewUser: isNew,
    };
  }

  /**
   * Exchange a refresh token for a new pair, ROTATING it (see Session in schema.prisma and
   * decideRefresh). At most two passes: a concurrent refresh of the same token can win the
   * conditional update, and the second pass then finds the token on the retry path.
   */
  async refresh(rawRefreshToken: string): Promise<TokenPairResponse> {
    const presentedHash = hashToken(rawRefreshToken);

    for (let pass = 0; pass < 2; pass += 1) {
      const now = this.deps.now();
      const byCurrent = await sessionRepository.findByRefreshHash(presentedHash);
      const byPrevious = byCurrent ? null : await sessionRepository.findByPreviousHash(presentedHash);
      const decision = decideRefresh(byCurrent, byPrevious, now);

      if (decision.kind === "unknown") break;
      if (decision.kind === "expired") {
        await sessionRepository.deleteById(decision.sessionId);
        break;
      }
      if (decision.kind === "reuse") {
        await sessionRepository.deleteById(decision.sessionId);
        console.warn(
          `[auth] refresh-token reuse on session ${decision.sessionId} (user ${decision.userId}); session revoked`
        );
        throw new UnauthorizedError(
          "This device was signed out for security. Please sign in again.",
          REFRESH_TOKEN_REUSED
        );
      }

      const next = generateRefreshToken();
      const nextHash = hashToken(next);
      const expiresAt = sessionIdleExpiry(now);
      const applied =
        decision.kind === "rotate"
          ? await sessionRepository.rotate(decision.sessionId, presentedHash, nextHash, expiresAt, now)
          : await sessionRepository.reissue(decision.sessionId, presentedHash, nextHash, expiresAt, now);
      if (applied) {
        const access = this.deps.accessTokens.sign(
          { userId: decision.userId, sessionId: decision.sessionId },
          now.getTime()
        );
        return { accessToken: access.token, expiresIn: access.expiresIn, refreshToken: next };
      }
    }

    throw new UnauthorizedError(
      "Your session has expired. Please sign in again.",
      INVALID_REFRESH_TOKEN
    );
  }

  /**
   * Sign this device out. Deliberately silent about whether the token existed: reporting "unknown
   * token" would make logout an oracle for probing which stolen values are live.
   */
  async logout(rawRefreshToken: string): Promise<void> {
    await sessionRepository.deleteByTokenHash(hashToken(rawRefreshToken));
  }

  /**
   * Every authenticated request: a valid, unexpired access token whose session still exists and
   * whose user is still active. Checking the session makes "sign out this device" immediate rather
   * than waiting out the access token. Null on any failure; the reason is logged, never returned.
   */
  async authenticate(accessToken: string): Promise<AuthenticatedSession | null> {
    const now = this.deps.now();
    let claims;
    try {
      claims = this.deps.accessTokens.verify(accessToken, now.getTime());
    } catch (err) {
      console.warn(`[auth] access token rejected: ${tokenRejectionReason(err)}`);
      return null;
    }

    const session = await sessionRepository.findForAuth(claims.sessionId);
    if (
      !session ||
      session.userId !== claims.userId ||
      session.expiresAt.getTime() <= now.getTime() ||
      session.user.deletedAt !== null
    ) {
      console.warn(`[auth] access token rejected: session ${claims.sessionId} is signed out`);
      return null;
    }

    if (shouldTouchLastUsed(session.lastUsedAt, now)) {
      // Best-effort bookkeeping: a failed write never fails the request it hangs off.
      sessionRepository.touch(session.id, now).catch((err: unknown) => {
        console.warn(`[auth] lastUsedAt update failed: ${(err as Error).message}`);
      });
    }
    return { userId: claims.userId, sessionId: claims.sessionId };
  }

  /**
   * Who is asking, from the token's signature and expiry alone — for GET /config, which must never
   * touch the database (HOA protocol 10 §2 rule 4). Good enough for targeting rules; never for
   * access. Silent on failure: an expired token at app launch is routine.
   */
  identifyWithoutSession(accessToken: string): string | null {
    try {
      return this.deps.accessTokens.verify(accessToken, this.deps.now().getTime()).userId;
    } catch {
      return null;
    }
  }
}

export const authService = new AuthService({
  verifyIdToken: verifyGoogleIdToken,
  accessTokens,
  now: () => new Date(),
});
