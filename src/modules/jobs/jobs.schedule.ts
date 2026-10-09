// Pure scheduling rules for the worker (deviation D5): when a daily job is due, and whether a run may
// be claimed. No database, no clock of their own — check:tree pins them.

/** Daily jobs run on India time (fixed +05:30, no daylight saving). */
export const IST_OFFSET_MINUTES = 330;

/** The IST calendar date and minute-of-day of an instant. */
export const istParts = (now: Date): { date: string; minuteOfDay: number } => {
  const shifted = new Date(now.getTime() + IST_OFFSET_MINUTES * 60_000);
  return {
    date: shifted.toISOString().slice(0, 10),
    minuteOfDay: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
};

const parseHhmm = (hhmm: string): number => {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!match) throw new Error(`Invalid daily time "${hhmm}" (expected HH:MM)`);
  return Number(match[1]) * 60 + Number(match[2]);
};

/**
 * The period a daily job at `atIst` is due for right now — today's IST date once that time has
 * passed — or null before it. One run per period: missing a day (worker down) catches up the same
 * day; it never runs twice.
 */
export const duePeriod = (atIst: string, now: Date): string | null => {
  const { date, minuteOfDay } = istParts(now);
  return minuteOfDay >= parseHhmm(atIst) ? date : null;
};

export interface RunState {
  status: string; // RUNNING | SUCCEEDED | FAILED
  startedAt: Date;
  finishedAt: Date | null;
}

/** A RUNNING row older than this is a crashed run, and may be claimed again. */
export const STALE_RUN_MS = 2 * 60 * 60 * 1000;
/** A FAILED run is retried after this pause. */
export const RETRY_AFTER_FAILURE_MS = 15 * 60 * 1000;

/** Whether a worker may start this job's run for the period, given the run recorded so far. */
export const mayClaim = (run: RunState | null, now: Date): boolean => {
  if (!run) return true;
  if (run.status === "SUCCEEDED") return false;
  if (run.status === "RUNNING") return now.getTime() - run.startedAt.getTime() > STALE_RUN_MS;
  const failedAt = (run.finishedAt ?? run.startedAt).getTime();
  return now.getTime() - failedAt > RETRY_AFTER_FAILURE_MS;
};
