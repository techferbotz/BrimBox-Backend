import { Router } from "express";
import { requireAuth } from "../../common/middleware/auth.middleware";
import { changes } from "./controller/sync.controller";

// /api/v1/sync — the change feed for the app's local cache.
const router = Router();
router.use(requireAuth);

router.get("/changes", changes);

export default router;
