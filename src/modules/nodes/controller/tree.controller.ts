import { Request, Response } from "express";
import { NotFoundError } from "../../../common/errors/AppError";
import { principalOf } from "../../../common/middleware/auth.middleware";
import { sendSuccess } from "../../../common/response/apiResponse";
import {
  isUuid,
  optionalEnum,
  optionalNonNegativeInt,
  optionalParentId,
  requireObjectBody,
  requireUuid,
} from "../../../common/validation";
import { treeService } from "../service/tree.service";

// Thin controllers for folders, nodes, trash and search. Every route sits behind requireAuth.

// A node id in the path. A malformed one can't name anything: 404, like a missing one.
const nodeIdParam = (req: Request<{ id: string }>): string => {
  if (!isUuid(req.params.id)) throw new NotFoundError("Not found");
  return req.params.id.toLowerCase();
};

const query = (req: Request, key: string): unknown => req.query[key];

// POST /api/v1/folders — { id, parentId?, name, onConflict? } → 201 (or 200 if that id already exists)
export const createFolder = async (req: Request, res: Response): Promise<void> => {
  const { userId } = principalOf(req);
  const body = requireObjectBody(req.body);
  const { node, created } = await treeService.createFolder(userId, {
    id: requireUuid(body.id, "id"),
    parentId: optionalParentId(body.parentId) ?? null,
    name: body.name,
    onConflict: optionalEnum(body.onConflict, "onConflict", ["fail", "rename"] as const, "fail"),
  });
  sendSuccess(res, node, created ? 201 : 200);
};

// GET /api/v1/folders/:id/children — :id is "root" or a folder id
export const listChildren = async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  const { userId } = principalOf(req);
  const folderId = req.params.id === "root" ? null : nodeIdParam(req);
  sendSuccess(res, await treeService.listChildren(userId, folderId, query(req, "cursor"), query(req, "limit")));
};

// GET /api/v1/nodes/:id
export const getNode = async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  const { userId } = principalOf(req);
  sendSuccess(res, await treeService.getNode(userId, nodeIdParam(req)));
};

// PATCH /api/v1/nodes/:id — { name?, parentId?, ifSeq? } → the node
export const updateNode = async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  const { userId } = principalOf(req);
  const id = nodeIdParam(req);
  const body = requireObjectBody(req.body);
  sendSuccess(
    res,
    await treeService.updateNode(userId, id, {
      name: body.name,
      parentId: optionalParentId(body.parentId),
      ifSeq: optionalNonNegativeInt(body.ifSeq, "ifSeq"),
    })
  );
};

// POST /api/v1/nodes/:id/trash → the node (now trashed)
export const trashNode = async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  const { userId } = principalOf(req);
  sendSuccess(res, await treeService.trash(userId, nodeIdParam(req)));
};

// POST /api/v1/nodes/:id/restore → the node (back in the tree)
export const restoreNode = async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  const { userId } = principalOf(req);
  sendSuccess(res, await treeService.restore(userId, nodeIdParam(req)));
};

// DELETE /api/v1/nodes/:id — permanently, from the trash → {}
export const purgeNode = async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  const { userId } = principalOf(req);
  await treeService.purge(userId, nodeIdParam(req));
  sendSuccess(res);
};

// GET /api/v1/trash
export const listTrash = async (req: Request, res: Response): Promise<void> => {
  const { userId } = principalOf(req);
  sendSuccess(res, await treeService.listTrash(userId, query(req, "cursor"), query(req, "limit")));
};

// DELETE /api/v1/trash → { purged }
export const emptyTrash = async (req: Request, res: Response): Promise<void> => {
  const { userId } = principalOf(req);
  sendSuccess(res, await treeService.emptyTrash(userId));
};

// GET /api/v1/search?q=
export const search = async (req: Request, res: Response): Promise<void> => {
  const { userId } = principalOf(req);
  sendSuccess(res, await treeService.search(userId, query(req, "q"), query(req, "cursor"), query(req, "limit")));
};
