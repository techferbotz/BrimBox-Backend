import { authService } from "../auth/service/auth.service";
import { treeService } from "../nodes/service/tree.service";
import { syncService } from "../sync/service/sync.service";
import { JobSpec } from "./scheduler";

// Every scheduled job, run by the worker. Staggered after 03:00 IST, the quietest hours.
export const JOBS: JobSpec[] = [
  // The privacy page promises trash is purged after TRASH_RETENTION_DAYS.
  { name: "trash.autoPurge", dailyAtIst: "03:00", run: (now) => treeService.purgeExpiredTrash(now) },
  { name: "sync.compactTombstones", dailyAtIst: "03:30", run: (now) => syncService.compactTombstones(now) },
  { name: "sessions.purgeExpired", dailyAtIst: "04:00", run: (now) => authService.purgeExpiredSessions(now) },
];
