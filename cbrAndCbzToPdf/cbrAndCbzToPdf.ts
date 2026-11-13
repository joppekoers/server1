#!/usr/bin/env bun
import { readdir, mkdir, rm, unlink } from "fs/promises";
import { existsSync } from "fs";
import { join, extname, dirname, basename } from "path";
import { cpus } from "os";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"]);
const QUALITY = Number(Bun.env.QUALITY) || 85;

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? walk(path) : [path];
    }),
  );
  return files.flat();
}

async function convert(file: string) {
  const outDir = join(dirname(file), basename(file, extname(file)));
  if (existsSync(outDir)) {
    console.log(`skip (exists): ${outDir}`);
    return;
  }

  await mkdir(outDir, { recursive: true });
  const ext = extname(file).toLowerCase();

  const extract =
    ext === ".cbz"
      ? Bun.spawn(["unzip", "-jqq", "-o", file, "-d", outDir], { stdout: "ignore", stderr: "pipe" })
      : Bun.spawn(["7z", "e", `-o${outDir}`, "-y", file], { stdout: "ignore", stderr: "pipe" });

  const code = await extract.exited;
  const extractOk = ext === ".cbz" ? code <= 1 : code === 0;
  if (!extractOk) {
    const err = await new Response(extract.stderr).text();
    console.error(`extract failed: ${file}\n${err}`);
    await rm(outDir, { recursive: true, force: true });
    return;
  }

  const images = (await readdir(outDir))
    .filter((name) => IMAGE_EXTENSIONS.has(extname(name).toLowerCase()))
    .sort()
    .map((name) => join(outDir, name));

  if (images.length === 0) {
    console.error(`no images: ${file}`);
    await rm(outDir, { recursive: true, force: true });
    return;
  }

  for (const img of images) {
    const webp = join(outDir, basename(img, extname(img)) + ".webp");
    if (img === webp) continue;
    const proc = Bun.spawn(
      ["cwebp", "-quiet", "-q", String(QUALITY), img, "-o", webp],
      { stdout: "ignore", stderr: "pipe" },
    );
    if ((await proc.exited) !== 0) {
      const err = await new Response(proc.stderr).text();
      console.error(`cwebp failed: ${img}\n${err}`);
      await rm(outDir, { recursive: true, force: true });
      return;
    }
    await unlink(img);
  }

  console.log(`created: ${outDir}`);
}

const roots = Bun.argv.slice(2);
if (roots.length === 0) {
  console.error("usage: cbrAndCbzToPdf.ts <path> [<path> ...]");
  process.exit(1);
}

const concurrency = Number(Bun.env.CONCURRENCY) || Math.max(1, cpus().length);

const queue: string[] = [];
for (const root of roots) {
  for (const file of await walk(root)) {
    const ext = extname(file).toLowerCase();
    if (ext === ".cbr" || ext === ".cbz") queue.push(file);
  }
}

async function worker() {
  while (queue.length > 0) {
    const file = queue.shift();
    if (file) await convert(file);
  }
}

await Promise.all(Array.from({ length: concurrency }, worker));
