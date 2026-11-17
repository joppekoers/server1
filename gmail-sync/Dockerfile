FROM oven/bun:alpine

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile

COPY src ./src
COPY drizzle ./drizzle

ENTRYPOINT ["bun", "run", "src/sync.ts"]
