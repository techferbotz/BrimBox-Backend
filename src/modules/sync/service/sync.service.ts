import { GoneError, NotFoundError } from "../../../common/errors/AppError";
import { ChangesDto, toNodeDto } from "../../nodes/dto/node.dto";
import { SYNC_DEFAULT_LIMIT, SYNC_MAX_LIMIT, TOMBSTONE_RETENTION_DAYS } from "../../nodes/nodes.policy";
import {
  compareFeedPosition,
  decodeSyncCursor,
  encodeSyncCursor,
  MAX_UUID,
  mustResync,
  parseLimit,
} from "../../nodes/nodes.rules";
import { treeRepository } from "../../nodes/repository/tree.repository";

// The change feed (deviation D4): every node changed since the device's cursor, in the order the
// changes were committed, tombstones included. Built for the app's local cache — no client clocks.

export class SyncService {
  /**
   * Changes after `cursorRaw` (everything when absent). Sequence numbers are assigned under the
   * user's row lock, so this can never skip a change that commits later with a lower number.
   */
  async changes(userId: string, cursorRaw: unknown, limitRaw: unknown): Promise<ChangesDto> {
    const cursor = decodeSyncCursor(cursorRaw);
    const limit = parseLimit(limitRaw, SYNC_DEFAULT_LIMIT, SYNC_MAX_LIMIT);

    // Read BEFORE the rows: `state.syncSeq` is the last COMMITTED sequence, and any change that
    // commits after this read gets a higher one.
    const state = await treeRepository.syncState(userId);
    if (!state) throw new NotFoundError("Account not found");
    if (cursor && mustResync(cursor, state.syncFloor)) {
      throw new GoneError(
        "This device has been away too long to catch up. Download the whole tree again (no cursor).",
        "RESYNC_REQUIRED"
      );
    }

    const rows = await treeRepository.changesSince(userId, cursor ?? null, limit + 1);
    const page = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    const last = page[page.length - 1];

    // Mid-feed: resume after the last row. At the end: everything committed up to `state.syncSeq`
    // has now been delivered, so the cursor jumps there — past compacted ranges and gaps — and never
    // moves backwards.
    let next = last ? { seq: last.syncSeq, id: last.id } : (cursor ?? { seq: 0n, id: MAX_UUID });
    if (!hasMore) {
      for (const candidate of [{ seq: state.syncSeq, id: MAX_UUID }, ...(cursor ? [cursor] : [])]) {
        if (compareFeedPosition(candidate, next) > 0) next = candidate;
      }
    }
    return {
      changes: page.map(toNodeDto),
      nextCursor: encodeSyncCursor({ seq: next.seq, id: next.id, floor: state.syncFloor }),
      hasMore,
    };
  }

  /** Job: drop tombstones older than TOMBSTONE_RETENTION_DAYS, raising each user's resync floor. */
  async compactTombstones(now: Date): Promise<string> {
    const cutoff = new Date(now.getTime() - TOMBSTONE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    let users = 0;
    let removed = 0;
    for (let batch = 0; batch < 1000; batch += 1) {
      const userIds = await treeRepository.usersWithTombstonesBefore(cutoff, 100);
      if (userIds.length === 0) break;
      for (const userId of userIds) {
        removed += await treeRepository.compactTombstones(userId, cutoff);
        users += 1;
      }
    }
    return `removed ${removed} tombstone(s) for ${users} user(s) purged before ${cutoff.toISOString()}`;
  }
}

export const syncService = new SyncService();
