import { Request, Response, NextFunction } from "express";

// Logs one line per request: method, URL, status code and response time. Deliberately never logs
// headers or bodies, so tokens and keys can't reach the logs.
// TODO(P7): redact the token in /s/:token paths before share links ship — a share token in a log
// line is a working link to someone's files.
export const requestLogger = (req: Request, res: Response, next: NextFunction): void => {
  const start = process.hrtime.bigint();

  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${durationMs.toFixed(1)}ms`);
  });

  next();
};
