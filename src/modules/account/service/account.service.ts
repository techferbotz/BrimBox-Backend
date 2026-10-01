import { ForbiddenError, NotFoundError, UnauthorizedError } from "../../../common/errors/AppError";
import { VerifyGoogleIdToken, verifyGoogleIdToken } from "../../../integrations/googleVerifier";
import { checkReauth } from "../../auth/auth.rules";
import { sessionRepository } from "../../auth/repository/session.repository";
import { SessionDto, toSessionDto, toUserDto, UserDto } from "../dto/account.dto";
import { userRepository } from "../repository/user.repository";

// Injected for the same reason as AuthService: check:auth-db runs this against a test database
// with a fake Google and a controllable clock.
export interface AccountServiceDeps {
  verifyIdToken: VerifyGoogleIdToken;
  now: () => Date;
}

export class AccountService {
  constructor(private readonly deps: AccountServiceDeps) {}

  async getProfile(userId: string): Promise<UserDto> {
    const user = await userRepository.findActiveById(userId);
    if (!user) throw new NotFoundError("Account not found");
    return toUserDto(user);
  }

  async listSessions(userId: string, currentSessionId: string): Promise<SessionDto[]> {
    const rows = await sessionRepository.listActiveForUser(userId, this.deps.now());
    return rows.map((row) => toSessionDto(row, currentSessionId));
  }

  /** Sign out one of the user's devices — possibly this one. Someone else's session is a 404. */
  async revokeSession(userId: string, sessionId: string): Promise<void> {
    const deleted = await sessionRepository.deleteForUser(userId, sessionId);
    if (!deleted) throw new NotFoundError("Session not found");
  }

  /** "Sign out all other devices" — e.g. after losing a phone. */
  async revokeOtherSessions(userId: string, currentSessionId: string): Promise<{ revoked: number }> {
    return { revoked: await sessionRepository.deleteOthersForUser(userId, currentSessionId) };
  }

  /** Register (or clear, with null) this device's push token. */
  async setPushToken(sessionId: string, token: string | null): Promise<void> {
    await sessionRepository.setPushToken(sessionId, token);
  }

  /**
   * Delete the account. Destructive and irreversible — from P3 it takes every stored file with it —
   * so it needs a FRESH Google sign-in for the same account, not just a valid access token: a
   * stolen token must not be able to wipe someone's storage.
   *
   * The re-auth failures are 403s, not 401s: the caller IS signed in, and a 401 would send the app
   * into its token-refresh flow instead of back to Google.
   */
  async deleteAccount(userId: string, idToken: string): Promise<void> {
    const user = await userRepository.findActiveById(userId);
    if (!user) throw new NotFoundError("Account not found");

    let identity;
    try {
      identity = await this.deps.verifyIdToken(idToken);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        throw new ForbiddenError("Confirm with Google again to delete your account", "REAUTH_REQUIRED");
      }
      throw err;
    }

    const now = this.deps.now();
    const check = checkReauth(identity, user.googleSub, now);
    if (!check.ok) {
      throw check.reason === "mismatch"
        ? new ForbiddenError(
            "Confirm with the Google account this BrimBox account uses",
            "REAUTH_MISMATCH"
          )
        : new ForbiddenError("Confirm with Google again to delete your account", "REAUTH_REQUIRED");
    }

    // Later phases hook in HERE, before the account is anonymised:
    //   P3 — queue every stored file for purge (the delete-account page promises removal within
    //        DELETION_STORAGE_PURGE_DAYS);
    //   P5 — close a final statement and cancel the auto-pay mandate.
    await userRepository.anonymiseAndSignOut(userId, now);
  }
}

export const accountService = new AccountService({
  verifyIdToken: verifyGoogleIdToken,
  now: () => new Date(),
});
