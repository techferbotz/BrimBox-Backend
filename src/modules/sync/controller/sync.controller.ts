import { Request, Response } from "express";
import { principalOf } from "../../../common/middleware/auth.middleware";
import { sendSuccess } from "../../../common/response/apiResponse";
import { syncService } from "../service/sync.service";

// GET /api/v1/sync/changes?cursor=&limit= → { changes, nextCursor, hasMore }
export const changes = async (req: Request, res: Response): Promise<void> => {
  const { userId } = principalOf(req);
  sendSuccess(res, await syncService.changes(userId, req.query.cursor, req.query.limit));
};
