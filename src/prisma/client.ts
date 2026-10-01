import { PrismaClient } from "@prisma/client";

// Reusable singleton Prisma client. Only repositories import it (HOA protocol 04).
// In development, ts-node-dev reloads modules; caching the client on `globalThis` avoids opening
// a new connection pool on every reload.
declare global {
  var prismaClient: PrismaClient | undefined;
}

export const prisma = global.prismaClient ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  global.prismaClient = prisma;
}
