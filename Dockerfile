# syntax=docker/dockerfile:1
FROM oven/bun:1.4.4 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:1.4.4 AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json bunfig.toml ./
# Bun runs TypeScript directly, and MikroORM migrations are read from src/.
# Copying src keeps the runtime layout identical to local development and
# avoids the dist/src/main.js path mismatch of the previous image.
COPY src ./src

EXPOSE 3000
CMD ["bun", "run", "src/main.ts"]
