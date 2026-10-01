import { Router } from "express";
import { optionalAuth } from "../../common/middleware/auth.middleware";
import { getConfig } from "./controller/remoteConfig.controller";

const router = Router();

// EVERYTHING about the caller is optional here — the config must be fetchable by any build in
// any state, including a first launch that hasn't generated a device id yet (HOA protocol 10
// §2 rule 5). req.deviceId comes from the global optionalDevice; optionalAuth adds req.userId
// from a valid access token by signature alone — never a 401, never a database read. Both are
// targeting inputs for future rules; a caller that sends neither simply gets the default config.
router.use(optionalAuth);

router.get("/", getConfig);

export default router;
