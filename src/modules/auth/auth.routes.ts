import { Router } from "express";
import { rateLimit } from "../../common/middleware/rateLimit";
import { logout, refresh, signInWithGoogle } from "./controller/auth.controller";

// /api/v1/auth — the only /api/v1 routes that don't take an access token: they are how one is
// obtained. Limits are per IP and generous (CGNAT); they stop floods, not users.
const router = Router();

router.post("/google", rateLimit({ name: "sign-in", limit: 60, windowSeconds: 600 }), signInWithGoogle);
router.post("/refresh", rateLimit({ name: "refresh", limit: 300, windowSeconds: 300 }), refresh);
router.post("/logout", rateLimit({ name: "logout", limit: 120, windowSeconds: 300 }), logout);

export default router;
