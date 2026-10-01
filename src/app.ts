import express from "express";
import cors from "cors";
import { config } from "./config/env";
import { requestLogger } from "./common/middleware/requestLogger";
import { errorHandler } from "./common/errors/errorHandler";
import { NotFoundError } from "./common/errors/AppError";
import legalRoutes from "./modules/legal/legal.routes";
import remoteConfigRoutes from "./modules/remoteConfig/remoteConfig.routes";

const app = express();
app.disable("x-powered-by");

// Global middleware
app.use(requestLogger); // registered first so it times everything
app.use(cors());
// Small JSON bodies only: file bytes never pass through this server — the app uploads straight
// to object storage with presigned URLs (docs/BACKEND_PLAN.md, deviation D2).
app.use(express.json({ limit: "1mb" }));

// Health check — the text protocol 05's deploy verification curls for.
app.get("/", (_req, res) => {
  res.type("text").send("BrimBox Backend Running");
});

// Public legal pages for the store listings and the app's own links (HOA protocol 12).
app.use(legalRoutes);

// Remote config: the app's first call on launch (HOA protocol 10). Nothing about the caller is
// required; its router attaches identity when present, for future targeting rules.
app.use("/config", remoteConfigRoutes);

// App API routes live under /api/v1 and arrive with P1 (auth).

// Unknown route -> standard 404 envelope, produced by the central error handler.
app.use((req) => {
  throw new NotFoundError(`Route not found: ${req.method} ${req.originalUrl}`);
});

// Centralized error handling — must be registered after all routes.
app.use(errorHandler);

app.listen(config.port, () => {
  console.log(`BrimBox backend listening on port ${config.port}`);
});
