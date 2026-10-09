// File-tree policy numbers. TRASH_RETENTION_DAYS is a public promise — the privacy page quotes it —
// so it lives with the code that enforces it (the trash.autoPurge job) and the legal page imports it.

/** Anything in the trash is permanently deleted (purged) this many days after it was trashed. */
export const TRASH_RETENTION_DAYS = 30;

/**
 * Purged nodes stay as tombstones this long so every device learns about the delete through the
 * change feed. After that, compaction removes them and a device that hasn't synced since must resync.
 */
export const TOMBSTONE_RETENTION_DAYS = 90;

/** UTF-8 bytes — the limit common phone and desktop file systems put on a single file name. */
export const MAX_NAME_BYTES = 255;

export const LIST_DEFAULT_LIMIT = 100;
export const LIST_MAX_LIMIT = 500;

export const SEARCH_MAX_QUERY_LENGTH = 100;

export const SYNC_DEFAULT_LIMIT = 500;
export const SYNC_MAX_LIMIT = 1000;
