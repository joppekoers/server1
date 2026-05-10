FROM oven/bun:debian

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*

COPY sync.ts /app/sync.ts

WORKDIR /app

ENTRYPOINT ["bun", "run", "sync.ts"]
