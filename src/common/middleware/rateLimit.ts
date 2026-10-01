import { Request, RequestHandler } from "express";
import { TooManyRequestsError } from "../errors/AppError";

/**
 * In-memory sliding-window limiter (Momentica's, adapted).
 *
 * Per-process, so exactly as good as a single instance — which is what we deploy. More than one
 * instance means moving this to a shared store; until then that store would be infrastructure with
 * no benefit.
 *
 * Leans on `app.set("trust proxy", 1)`: behind nginx every request arrives from loopback, and
 * without that setting every caller would share one bucket. Limits are generous because mobile
 * carriers in India put many users behind one IP (CGNAT); they exist to stop floods, not users.
 */

interface Window {
  hits: number[];
}

const windows = new Map<string, Window>();

const SWEEP_INTERVAL_MS = 60_000;
const LONGEST_WINDOW_MS = 3_600_000;
setInterval(() => {
  const now = Date.now();
  for (const [key, window] of windows) {
    const last = window.hits[window.hits.length - 1] ?? 0;
    if (window.hits.length === 0 || now - last > LONGEST_WINDOW_MS) {
      windows.delete(key);
    }
  }
}, SWEEP_INTERVAL_MS).unref();

export interface RateLimitConfig {
  name: string;
  limit: number;
  windowSeconds: number;
  key?: (req: Request) => string;
}

const byIp = (req: Request): string => req.ip ?? "unknown";

export const rateLimit = (config: RateLimitConfig): RequestHandler => {
  const keyFn = config.key ?? byIp;
  const windowMs = config.windowSeconds * 1000;

  return (req, _res, next) => {
    const key = `${config.name}:${keyFn(req)}`;
    const now = Date.now();
    const window = windows.get(key) ?? { hits: [] };

    // Drop everything that fell out of the window.
    const cutoff = now - windowMs;
    let firstLive = 0;
    while (firstLive < window.hits.length && (window.hits[firstLive] ?? 0) <= cutoff) {
      firstLive += 1;
    }
    if (firstLive > 0) window.hits.splice(0, firstLive);

    if (window.hits.length >= config.limit) {
      const oldest = window.hits[0] ?? now;
      const retryAfter = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
      windows.set(key, window);
      next(new TooManyRequestsError(retryAfter));
      return;
    }

    window.hits.push(now);
    windows.set(key, window);
    next();
  };
};
