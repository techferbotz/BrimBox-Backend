import { Request, Response } from "express";
import { remoteConfigService } from "../service/remoteConfig.service";
import { contextFromRequest } from "../remoteConfig.context";
import { sendSuccess } from "../../../common/response/apiResponse";

// GET /config — the app's behaviour switches, resolved for this caller. Nothing about the caller
// is required (see the routes file).
export const getConfig = (req: Request, res: Response): void => {
  const ctx = contextFromRequest(req);
  const result = remoteConfigService.resolve(ctx);
  // The answer can differ per caller (headers, identity) and can change without a deploy, so
  // nothing between the app and us may cache it. The client caches it itself, by `ttlSeconds`.
  res.set("Cache-Control", "no-store");
  sendSuccess(res, result);
};
