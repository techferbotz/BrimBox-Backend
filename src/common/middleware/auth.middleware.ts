import { Request, Response, NextFunction } from "express";
import { UnauthorizedError } from "../errors/AppError";
import { authService } from "../../modules/auth/service/auth.service";

const bearerToken = (req: Request): string | null => {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? "");
  return match ? (match[1] ?? null) : null;
};

/**
 * Required auth for every /api/v1 route except sign-in, refresh and logout. A 401 here means:
 * refresh once, and if that fails, sign in again. The WWW-Authenticate header (RFC 6750) marks it
 * as a bearer challenge, which is what HTTP clients' auth plugins (Ktor's `Auth`) key on.
 */
export const requireAuth = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const token = bearerToken(req);
  if (!token) {
    res.set("WWW-Authenticate", "Bearer");
    throw new UnauthorizedError("Sign-in required", "UNAUTHORIZED");
  }
  const auth = await authService.authenticate(token);
  if (!auth) {
    res.set("WWW-Authenticate", 'Bearer error="invalid_token"');
    throw new UnauthorizedError("Access token is invalid or expired", "INVALID_TOKEN");
  }
  req.userId = auth.userId;
  req.sessionId = auth.sessionId;
  next();
};

/**
 * Optional identity for GET /config only: attaches req.userId from a valid token so targeting rules
 * can use it. Never rejects and never touches the database — the config must answer for any caller
 * in any state, even with Postgres down (HOA protocol 10 §2).
 */
export const optionalAuth = (req: Request, _res: Response, next: NextFunction): void => {
  const token = bearerToken(req);
  if (token) {
    const userId = authService.identifyWithoutSession(token);
    if (userId) req.userId = userId;
  }
  next();
};
