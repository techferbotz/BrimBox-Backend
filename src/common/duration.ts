// Parses a duration like "1h", "15m", "900s" or "900" (seconds) into whole seconds. Pure, so the
// check:* scripts can exercise it without loading config/env.ts.
//
// Deliberately narrow: integer amount + optional s/m/h/d unit. Anything else returns null and the
// caller decides how to fail.
const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

export const parseDurationSeconds = (raw: string): number | null => {
  const match = /^(\d{1,9})\s*([smhd]?)$/i.exec(raw.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = (match[2] || "s").toLowerCase();
  return amount * (UNIT_SECONDS[unit] ?? 1);
};
