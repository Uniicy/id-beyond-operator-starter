# syntax=docker/dockerfile:1.7
# ---------- builder ----------
FROM node:20-alpine AS builder

# `argon2` pulls in node-gyp, so we need build tooling in the builder layer.
RUN apk add --no-cache python3 make g++

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.18.2 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json drizzle.config.ts ./
COPY src ./src
RUN pnpm build

# Prune dev deps so the runtime image ships only production modules.
RUN pnpm prune --prod

# ---------- runtime ----------
FROM node:20-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/db/migrations ./dist/db/migrations
COPY package.json ./

EXPOSE 4499
CMD ["node", "dist/index.js"]
