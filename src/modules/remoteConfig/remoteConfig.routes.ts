import { Router } from "express";
import { optionalDevice } from "../../common/middleware/device.middleware";
import { getConfig } from "./controller/remoteConfig.controller";

const router = Router();

// EVERYTHING about the caller is optional here — the config must be fetchable by any build in
// any state, including a first launch that hasn't generated a device id yet (HOA protocol 10
// §2 rule 5). optionalDevice sets req.deviceId when X-Device-Id is present; P1 adds optionalAuth
// (req.userId from a valid access token, never a 401 here). Both are worth sending: they are the
// targeting inputs for future rules. A caller that sends neither simply gets the default config.
router.use(optionalDevice);

router.get("/", getConfig);

export default router;
