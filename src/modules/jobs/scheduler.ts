import { duePeriod } from "./jobs.schedule";
import { jobRunRepository } from "./repository/jobRun.repository";

// The worker's scheduler (deviation D5): once a minute, every daily job that's due and unclaimed
// for today's period runs once. Jobs must be idempotent — a crash mid-run means it runs again.

export interface JobSpec {
  name: string;
  /** IST time of day the job becomes due, "HH:MM". */
  dailyAtIst: string;
  /** Does the work; returns a one-line summary for the JobRun row and the log. */
  run: (now: Date) => Promise<string>;
}

export interface Scheduler {
  /** One pass over every job (also what the timer calls). */
  tick: () => Promise<void>;
  stop: () => void;
}

export const startScheduler = (
  jobs: JobSpec[],
  options: { now?: () => Date; intervalMs?: number; autoStart?: boolean } = {}
): Scheduler => {
  const now = options.now ?? (() => new Date());
  let busy = false;

  const tick = async (): Promise<void> => {
    if (busy) return; // a long job is still running: the next tick picks up the rest
    busy = true;
    try {
      for (const job of jobs) {
        const period = duePeriod(job.dailyAtIst, now());
        if (period === null) continue;
        if (!(await jobRunRepository.claim(job.name, period, now()))) continue;
        const started = Date.now();
        try {
          const summary = await job.run(now());
          await jobRunRepository.succeed(job.name, period, now(), summary);
          console.log(`[worker] ${job.name} ${period} ok in ${Date.now() - started}ms: ${summary}`);
        } catch (err) {
          const message = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
          await jobRunRepository.fail(job.name, period, now(), message);
          console.error(`[worker] ${job.name} ${period} FAILED after ${Date.now() - started}ms:`, err);
        }
      }
    } catch (err) {
      // e.g. the database is unreachable: log and try again on the next tick
      console.error("[worker] scheduler tick failed:", err);
    } finally {
      busy = false;
    }
  };

  if (options.autoStart === false) return { tick, stop: () => undefined };
  const timer = setInterval(() => void tick(), options.intervalMs ?? 60_000);
  void tick();
  return { tick, stop: () => clearInterval(timer) };
};
