import dotenv from "dotenv";

// Load variables from .env into process.env as early as possible. `quiet` suppresses dotenv
// v17's startup banner (and the harmless "injected env (0)" line in containers, where variables
// come from compose's env_file rather than a .env inside the image).
dotenv.config({ quiet: true });

// Fail fast if a required variable is missing, so we never run with an undefined value.
const requireEnv = (key: string): string => {
  const value = process.env[key];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value.trim();
};

// An absolute http(s) origin with no path, query or trailing slash — e.g. https://brimbox.ferbotz.com.
// Links are built as `${origin}/privacy`, so anything else would produce broken URLs.
const requireOrigin = (key: string): string => {
  const raw = requireEnv(key);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Environment variable ${key} must be an absolute URL (got "${raw}")`);
  }
  const isHttp = url.protocol === "https:" || url.protocol === "http:";
  if (!isHttp || url.pathname !== "/" || url.search || url.hash || raw.endsWith("/")) {
    throw new Error(
      `Environment variable ${key} must be an origin like https://brimbox.ferbotz.com — ` +
        `http(s), no path, no trailing slash (got "${raw}")`
    );
  }
  return url.origin;
};

const parsePort = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (!raw || !raw.trim()) return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Environment variable ${key} must be a port number (got "${raw}")`);
  }
  return port;
};

// Parses an OPTIONAL env var holding a JSON object. Unset/blank -> null. Invalid JSON or a
// non-object -> throw, so a mistyped value fails the boot (like requireEnv) instead of being
// quietly ignored.
const parseJsonObjectEnv = (key: string): Record<string, unknown> | null => {
  const raw = process.env[key];
  if (!raw || !raw.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Environment variable ${key} is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Environment variable ${key} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
};

// Centralized, typed configuration. The ONLY reader of process.env (HOA protocol 04) — import
// this instead of reading the environment anywhere else.
export const config = {
  port: parsePort("PORT", 8080),
  // Public origin of this backend. The legal pages' absolute URLs in GET /config → links are
  // built from it (HOA protocol 12), so it is the one place the host name is written down.
  appPublicUrl: requireOrigin("APP_PUBLIC_URL"),
  // Optional JSON patch applied over the default remote config (GET /config) for every caller,
  // e.g. {"maintenance":{"enabled":true,"message":"Back in 10 minutes"}}. Lets ops flip a flag
  // with an .env change + container recreate — no code deploy. Every key must exist in
  // DEFAULT_REMOTE_CONFIG with a matching type; anything else fails startup on purpose
  // (validated in remoteConfig.service.ts). See docs/REMOTE_CONFIG.md.
  remoteConfigOverrides: parseJsonObjectEnv("REMOTE_CONFIG_OVERRIDES"),
};
