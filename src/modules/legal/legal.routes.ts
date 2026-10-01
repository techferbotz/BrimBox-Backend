import { Router } from "express";
import { legalController } from "./controller/legal.controller";
import { LEGAL_PATHS } from "./legal.view";

// Root-mounted (not under /api/v1), public, no identity middleware (HOA protocol 12). Each page
// also answers on its common alias, so both usual URLs resolve.
const router = Router();

router.get([LEGAL_PATHS.privacy, "/privacy-policy"], legalController.privacyPolicy);
router.get([LEGAL_PATHS.terms, "/terms-of-service"], legalController.termsOfService);
router.get([LEGAL_PATHS.deleteAccount, "/account-deletion"], legalController.deleteAccount);

export default router;
