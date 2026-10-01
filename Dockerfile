# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# BrimBox backend — multi-stage build (HOA protocol 04), run on the shared EC2 box.
#
#   builder : install ALL deps, compile TS -> dist/
#   runner  : production deps only + compiled app, non-root
#
# The build needs no secrets; everything is supplied at runtime from the server's .env.
# P1 adds OpenSSL + `prisma generate` here when the first Prisma model lands.
# ---------------------------------------------------------------------------

# ----------------------------- Builder -------------------------------------
FROM node:22-slim AS builder

WORKDIR /app

# Install dependencies first (cached unless package*.json changes).
COPY package*.json ./
RUN npm ci

# Compile TypeScript -> dist/
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ----------------------------- Runner --------------------------------------
FROM node:22-slim AS runner

ENV NODE_ENV=production
# src/config/env.ts reads PORT; docker-compose.prod.yml publishes it on a loopback host port.
ENV PORT=8080

WORKDIR /app

# Production dependencies only (no dev toolchain in the final image).
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

# Drop root privileges — the official image ships a non-root `node` user.
USER node

EXPOSE 8080

CMD ["node", "dist/app.js"]
