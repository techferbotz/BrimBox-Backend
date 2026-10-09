import { Router } from "express";
import { requireAuth } from "../../common/middleware/auth.middleware";
import {
  createFolder,
  emptyTrash,
  getNode,
  listChildren,
  listTrash,
  purgeNode,
  restoreNode,
  search,
  trashNode,
  updateNode,
} from "./controller/tree.controller";

// The file tree, as four routers mounted in app.ts. Each applies requireAuth itself, so an unknown
// /api/v1 path still falls through to a 404 instead of a 401.

/** /api/v1/folders */
export const foldersRouter = Router();
foldersRouter.use(requireAuth);
foldersRouter.post("/", createFolder);
foldersRouter.get("/:id/children", listChildren);

/** /api/v1/nodes */
export const nodesRouter = Router();
nodesRouter.use(requireAuth);
nodesRouter.get("/:id", getNode);
nodesRouter.patch("/:id", updateNode);
nodesRouter.post("/:id/trash", trashNode);
nodesRouter.post("/:id/restore", restoreNode);
nodesRouter.delete("/:id", purgeNode);

/** /api/v1/trash */
export const trashRouter = Router();
trashRouter.use(requireAuth);
trashRouter.get("/", listTrash);
trashRouter.delete("/", emptyTrash);

/** /api/v1/search */
export const searchRouter = Router();
searchRouter.use(requireAuth);
searchRouter.get("/", search);
