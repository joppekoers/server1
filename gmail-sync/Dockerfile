FROM oven/bun:alpine

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile

COPY *.ts ./
COPY drizzle ./drizzle

ENTRYPOINT ["bun", "run", "sync.ts"]
