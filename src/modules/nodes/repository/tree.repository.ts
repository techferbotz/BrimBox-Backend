import { Node, NodeKind, Prisma } from "@prisma/client";
import { prisma } from "../../../prisma/client";
import { escapeLike, NameCursor, SyncCursor, TrashCursor } from "../nodes.rules";

// All Node database access (no Prisma outside repositories, HOA protocol 04). Every WRITE goes
// through TreeTx, inside a transaction that holds the user's row lock — that lock is what makes the
// sibling-name check race-free and keeps sync sequence numbers in commit order.
//
// Recursive queries stop at depth 10000: the service never lets a cycle form, but a query must not
// loop forever if bad data ever slipped in.

// Raw SQL timestamps: pin to UTC explicitly, whatever the session time zone is.
const utc = (date: Date): Prisma.Sql => Prisma.sql`(${date.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;

/** Which children a folder listing shows: an active folder's active children, or a trashed one's. */
export type ChildState = "active" | "trashed";

/** The tree, as one locked transaction for one user sees it. `seq` stamps every node it changes. */
export class TreeTx {
  constructor(
    private readonly tx: Prisma.TransactionClient,
    readonly userId: string,
    readonly seq: bigint,
    readonly now: Date
  ) {}

  /** A node with this id, whoever owns it — ids come from the app, so a clash must be noticed. */
  async findById(id: string): Promise<Node | null> {
    return this.tx.node.findUnique({ where: { id } });
  }

  async findOwned(id: string): Promise<Node | null> {
    return this.tx.node.findFirst({ where: { id, userId: this.userId } });
  }

  async isNameTaken(parentId: string | null, nameKey: string, exceptId?: string): Promise<boolean> {
    const clash = await this.tx.node.findFirst({
      where: {
        userId: this.userId,
        parentId,
        nameKey,
        trashedAt: null,
        deletedAt: null,
        ...(exceptId ? { NOT: { id: exceptId } } : {}),
      },
      select: { id: true },
    });
    return clash !== null;
  }

  /** Active sibling keys starting with `prefix`: the taken set for choosing "name (n)". */
  async siblingKeysWithPrefix(parentId: string | null, prefix: string): Promise<Set<string>> {
    const rows = await this.tx.node.findMany({
      where: { userId: this.userId, parentId, trashedAt: null, deletedAt: null, nameKey: { startsWith: escapeLike(prefix) } },
      select: { nameKey: true },
    });
    return new Set(rows.map((row) => row.nameKey));
  }

  /** True if putting `nodeId` under `newParentId` would make a cycle (the parent is it, or inside it). */
  async wouldCreateCycle(nodeId: string, newParentId: string): Promise<boolean> {
    const rows = await this.tx.$queryRaw<{ hit: boolean }[]>`
      WITH RECURSIVE up AS (
        SELECT "id", "parentId", 1 AS depth FROM "Node"
        WHERE "id" = ${newParentId}::uuid AND "userId" = ${this.userId}::uuid
        UNION ALL
        SELECT n."id", n."parentId", up.depth + 1 FROM "Node" n
        JOIN up ON n."id" = up."parentId"
        WHERE n."userId" = ${this.userId}::uuid AND up.depth < 10000
      )
      SELECT EXISTS (SELECT 1 FROM up WHERE "id" = ${nodeId}::uuid) AS hit`;
    return rows[0]?.hit === true;
  }

  async createFolder(data: { id: string; parentId: string | null; name: string; nameKey: string }): Promise<Node> {
    return this.tx.node.create({
      data: {
        ...data,
        userId: this.userId,
        kind: NodeKind.FOLDER,
        syncSeq: this.seq,
        createdAt: this.now,
        updatedAt: this.now,
      },
    });
  }

  /** Rename and/or move one node. */
  async place(id: string, data: { parentId: string | null; name: string; nameKey: string }): Promise<Node> {
    return this.tx.node.update({ where: { id }, data: { ...data, syncSeq: this.seq, updatedAt: this.now } });
  }

  /** Trash `rootId` and every active node under it, as one batch. Returns the number trashed. */
  async trashSubtree(rootId: string): Promise<number> {
    return this.tx.$executeRaw`
      WITH RECURSIVE sub AS (
        SELECT "id", 1 AS depth FROM "Node"
        WHERE "id" = ${rootId}::uuid AND "userId" = ${this.userId}::uuid
        UNION ALL
        SELECT n."id", sub.depth + 1 FROM "Node" n
        JOIN sub ON n."parentId" = sub."id"
        WHERE n."userId" = ${this.userId}::uuid AND n."deletedAt" IS NULL AND sub.depth < 10000
      )
      UPDATE "Node"
      SET "trashedAt" = ${utc(this.now)}, "trashRootId" = ${rootId}::uuid,
          "syncSeq" = ${this.seq}, "updatedAt" = ${utc(this.now)}
      WHERE "id" IN (SELECT "id" FROM sub) AND "trashedAt" IS NULL AND "deletedAt" IS NULL`;
  }

  /** Bring back the batch trashed with `rootId`, putting the root where the service decided. */
  async restoreBatch(rootId: string, placement: { parentId: string | null; name: string; nameKey: string }): Promise<Node> {
    await this.tx.node.updateMany({
      where: { userId: this.userId, trashRootId: rootId, deletedAt: null },
      data: { trashedAt: null, trashRootId: null, syncSeq: this.seq, updatedAt: this.now },
    });
    return this.tx.node.update({
      where: { id: rootId },
      data: { ...placement, syncSeq: this.seq, updatedAt: this.now },
    });
  }

  // A purged node keeps only what the change feed needs to announce the delete: its name is cleared.
  private purgeData() {
    return { deletedAt: this.now, name: "", nameKey: "", mimeType: null, syncSeq: this.seq, updatedAt: this.now };
  }

  /** Purge `rootId` and everything under it, trashed or not. Returns the number purged. */
  async purgeSubtree(rootId: string): Promise<number> {
    return this.tx.$executeRaw`
      WITH RECURSIVE sub AS (
        SELECT "id", 1 AS depth FROM "Node"
        WHERE "id" = ${rootId}::uuid AND "userId" = ${this.userId}::uuid
        UNION ALL
        SELECT n."id", sub.depth + 1 FROM "Node" n
        JOIN sub ON n."parentId" = sub."id"
        WHERE n."userId" = ${this.userId}::uuid AND n."deletedAt" IS NULL AND sub.depth < 10000
      )
      UPDATE "Node"
      SET "deletedAt" = ${utc(this.now)}, "name" = '', "nameKey" = '', "mimeType" = NULL,
          "syncSeq" = ${this.seq}, "updatedAt" = ${utc(this.now)}
      WHERE "id" IN (SELECT "id" FROM sub) AND "deletedAt" IS NULL`;
  }

  /** Empty the trash. Everything under a trashed node is trashed too, so this covers whole subtrees. */
  async purgeAllTrashed(): Promise<number> {
    const { count } = await this.tx.node.updateMany({
      where: { userId: this.userId, trashedAt: { not: null }, deletedAt: null },
      data: this.purgeData(),
    });
    return count;
  }

  /**
   * Purge what has been in the trash since before `cutoff`. Every node of a batch shares its
   * `trashedAt`, and a batch nested inside an older one is older still, so a plain time filter
   * takes whole subtrees.
   */
  async purgeTrashedBefore(cutoff: Date): Promise<number> {
    const { count } = await this.tx.node.updateMany({
      where: { userId: this.userId, trashedAt: { lt: cutoff }, deletedAt: null },
      data: this.purgeData(),
    });
    return count;
  }
}

const nameOrder = [{ nameKey: "asc" as const }, { id: "asc" as const }];

const afterName = (after: NameCursor | null) =>
  after ? { OR: [{ nameKey: { gt: after.nameKey } }, { nameKey: after.nameKey, id: { gt: after.id } }] } : {};

export class TreeRepository {
  /**
   * Run `fn` in a transaction that first takes the user's row lock and allocates the next sync
   * sequence. Every tree change for this user is serialised by that lock, and the sequence numbers
   * the changes in commit order — which is what lets the change feed promise it never skips one.
   */
  async inUserTransaction<T>(userId: string, now: Date, fn: (tree: TreeTx) => Promise<T>): Promise<T> {
    return prisma.$transaction(
      async (tx) => {
        const { syncSeq } = await tx.user.update({
          where: { id: userId },
          data: { syncSeq: { increment: 1 } },
          select: { syncSeq: true },
        });
        return fn(new TreeTx(tx, userId, syncSeq, now));
      },
      { maxWait: 10_000, timeout: 30_000 }
    );
  }

  async findOwned(userId: string, id: string): Promise<Node | null> {
    return prisma.node.findFirst({ where: { id, userId } });
  }

  /** One kind of a folder's children (the root when `parentId` is null), by name. */
  async listChildrenOfKind(
    userId: string,
    parentId: string | null,
    kind: NodeKind,
    state: ChildState,
    after: NameCursor | null,
    take: number
  ): Promise<Node[]> {
    return prisma.node.findMany({
      where: {
        userId,
        parentId,
        kind,
        deletedAt: null,
        trashedAt: state === "active" ? null : { not: null },
        ...afterName(after),
      },
      orderBy: nameOrder,
      take,
    });
  }

  /** What the user put in the trash (batch roots only), most recent first. */
  async listTrashRoots(userId: string, after: TrashCursor | null, take: number): Promise<Node[]> {
    return prisma.node.findMany({
      where: {
        userId,
        deletedAt: null,
        trashedAt: { not: null },
        trashRootId: { equals: prisma.node.fields.id },
        ...(after
          ? { OR: [{ trashedAt: { lt: after.trashedAt } }, { trashedAt: after.trashedAt, id: { lt: after.id } }] }
          : {}),
      },
      orderBy: [{ trashedAt: "desc" }, { id: "desc" }],
      take,
    });
  }

  /** Active nodes whose name contains `fragment` (already a name key), by name. */
  async search(userId: string, fragment: string, after: NameCursor | null, take: number): Promise<Node[]> {
    return prisma.node.findMany({
      where: { userId, trashedAt: null, deletedAt: null, nameKey: { contains: escapeLike(fragment) }, ...afterName(after) },
      orderBy: nameOrder,
      take,
    });
  }

  /** Every node changed after `after`, in (syncSeq, id) order — tombstones included. */
  async changesSince(userId: string, after: SyncCursor | null, take: number): Promise<Node[]> {
    return prisma.node.findMany({
      where: {
        userId,
        ...(after
          ? { OR: [{ syncSeq: { gt: after.seq } }, { syncSeq: after.seq, id: { gt: after.id } }] }
          : {}),
      },
      orderBy: [{ syncSeq: "asc" }, { id: "asc" }],
      take,
    });
  }

  async syncState(userId: string): Promise<{ syncSeq: bigint; syncFloor: bigint } | null> {
    return prisma.user.findFirst({ where: { id: userId, deletedAt: null }, select: { syncSeq: true, syncFloor: true } });
  }

  // ---------------------------------------------------------------- jobs

  async usersWithTrashBefore(cutoff: Date, take: number): Promise<string[]> {
    const rows = await prisma.node.findMany({
      where: { trashedAt: { lt: cutoff }, deletedAt: null },
      select: { userId: true },
      distinct: ["userId"],
      take,
    });
    return rows.map((row) => row.userId);
  }

  async usersWithTombstonesBefore(cutoff: Date, take: number): Promise<string[]> {
    const rows = await prisma.node.findMany({
      where: { deletedAt: { lt: cutoff } },
      select: { userId: true },
      distinct: ["userId"],
      take,
    });
    return rows.map((row) => row.userId);
  }

  /**
   * Delete the user's tombstones purged before `cutoff`, raising `syncFloor` past them, so a device
   * whose cursor predates them is told to resync rather than silently missing those deletes. A
   * parent is never purged earlier than its children, so whole subtrees go together.
   */
  async compactTombstones(userId: string, cutoff: Date): Promise<number> {
    return prisma.$transaction(async (tx) => {
      const user = await tx.user.update({
        where: { id: userId },
        data: { syncSeq: { increment: 0 } }, // takes the row lock: no tree change interleaves
        select: { syncFloor: true },
      });
      const { _max } = await tx.node.aggregate({ where: { userId, deletedAt: { lt: cutoff } }, _max: { syncSeq: true } });
      if (_max.syncSeq === null) return 0;
      const { count } = await tx.node.deleteMany({ where: { userId, deletedAt: { lt: cutoff } } });
      if (_max.syncSeq > user.syncFloor) {
        await tx.user.update({ where: { id: userId }, data: { syncFloor: _max.syncSeq } });
      }
      return count;
    });
  }
}

export const treeRepository = new TreeRepository();
