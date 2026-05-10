import { readdir, stat, mkdir, unlink, watch } from "fs/promises";
import { join, extname, basename, dirname, relative } from "path";

const INPUT_DIR = "/input";
const OUTPUT_DIR = "/output";
const POLL_INTERVAL = 5 * 60_000;
const DEBOUNCE_MS = 5_000;
const VIDEO_EXTENSIONS = new Set([".mkv", ".mp4", "avi"]);
const EXCLUDED_LANGUAGES = new Set(["rus", "ru", "ukr", "uk"]);
const COMPATIBLE_AUDIO_CODECS = new Set(["aac", "mp3", "opus"]);
const PARALLEL_JOBS = 2;

async function detectGpu() {
  const proc = Bun.spawn(
    ["ffmpeg", "-f", "lavfi", "-i", "nullsrc=s=16x16:d=0.1", "-c:v", "hevc_nvenc", "-f", "null", "-"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const exitCode = await proc.exited;
  return exitCode === 0;
}

const HAS_GPU = await detectGpu().catch(() => false);

interface Stream {
  index: number;
  codec_type: string;
  codec_name: string;
  tags?: { language?: string; title?: string };
  disposition?: { default: number; forced: number; hearing_impaired: number };
}

interface ProbeResult {
  streams: Stream[];
}

function normalizeFilename(name: string) {
  const ext = extname(name);
  const base = name.slice(0, -ext.length);

  let cleaned = base.replace(/[._]/g, " ");
  cleaned = cleaned.replace(/[(\[\])]/g, " ");

  const yearMatch = cleaned.match(/\b((?:19|20)\d{2})\b/);
  if (yearMatch) {
    const yearIndex = cleaned.indexOf(yearMatch[1]);
    cleaned = cleaned.slice(0, yearIndex + yearMatch[1].length);
  }

  cleaned = cleaned.replace(/\s+/g, " ").trim();

  if (cleaned.length > 0) {
    cleaned = cleaned[0].toUpperCase() + cleaned.slice(1).toLowerCase();
  }

  return cleaned + ext;
}

async function probeFile(path: string) {
  const proc = Bun.spawn(["ffprobe", "-v", "quiet", "-print_format", "json", "-show_streams", path], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) return new Error(`ffprobe failed with exit code ${exitCode} for ${path}`);

  const parsed = JSON.parse(output) as ProbeResult;
  if (!parsed.streams?.length) return new Error(`ffprobe returned no streams for ${path}`);
  return parsed;
}

function findEnglishAudio(audioStreams: Stream[]) {
  const english = audioStreams.find((s) => s.tags?.language === "eng" || s.tags?.language === "en");
  return english?.index ?? null;
}

function findEnglishSubtitle(subStreams: Stream[]) {
  const englishSubs = subStreams.filter((s) => s.tags?.language === "eng" || s.tags?.language === "en");

  // Prefer non-forced, non-hearing-impaired
  const full = englishSubs.find(
    (s) =>
      !s.disposition?.forced &&
      !s.disposition?.hearing_impaired &&
      !/forced|sdh|hearing.impaired/i.test(s.tags?.title ?? ""),
  );
  if (full) return full.index;

  return englishSubs[0]?.index ?? null;
}

async function processFile(inputPath: string, outputPath: string) {
  const probe = await probeFile(inputPath);
  if (probe instanceof Error) {
    console.error(probe.message);
    return probe;
  }

  const { streams } = probe;
  const videoStream = streams.find((s) => s.codec_type === "video");
  const audioStreams = streams.filter(
    (s) => s.codec_type === "audio" && !EXCLUDED_LANGUAGES.has(s.tags?.language ?? ""),
  );
  const subStreams = streams.filter(
    (s) => s.codec_type === "subtitle" && !EXCLUDED_LANGUAGES.has(s.tags?.language ?? ""),
  );

  if (!videoStream || audioStreams.length === 0) {
    const err = new Error(`Skipping ${inputPath}: missing video or audio stream`);
    console.error(err.message);
    return err;
  }

  const englishAudioIndex = findEnglishAudio(audioStreams);
  const selectedAudioIndex = englishAudioIndex ?? audioStreams[0].index;
  const selectedAudio = streams.find((s) => s.index === selectedAudioIndex)!;
  const audioNeedsTranscode = !COMPATIBLE_AUDIO_CODECS.has(selectedAudio.codec_name);

  const englishSubIndex = findEnglishSubtitle(subStreams);

  const args: string[] = [
    "ffmpeg",
    "-y",
    "-loglevel",
    "error",
    "-i",
    inputPath,
    "-map",
    `0:${videoStream.index}`,
    "-map",
    `0:${selectedAudioIndex}`,
  ];

  for (const sub of subStreams) {
    args.push("-map", `0:${sub.index}`);
  }

  if (HAS_GPU) {
    args.push("-c:v", "hevc_nvenc", "-tag:v", "hvc1", "-preset", "medium", "-cq", "18");
  } else {
    args.push("-c:v", "libx265", "-tag:v", "hvc1", "-preset", "medium", "-crf", "18", "-threads", "0");
  }

  args.push("-c:a", audioNeedsTranscode ? "aac" : "copy");
  if (audioNeedsTranscode) {
    args.push("-b:a", "192k");
  }

  args.push("-c:s", "mov_text");
  args.push("-disposition:a:0", "default");

  if (subStreams.length > 0) {
    const outputSubIndex = subStreams.findIndex((s) => s.index === englishSubIndex);
    for (let i = 0; i < subStreams.length; i++) {
      args.push(`-disposition:s:${i}`, i === outputSubIndex ? "default" : "0");
    }
  }

  args.push(outputPath);

  console.log(`Processing ${inputPath} → ${outputPath}`);
  console.log(`  Video: transcode (HEVC), Audio: ${audioNeedsTranscode ? "transcode" : "copy"}`);

  const proc = Bun.spawn(args, { stdout: "inherit", stderr: "inherit" });
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    await unlink(outputPath).catch(() => {});
    return new Error(`ffmpeg failed with exit code ${exitCode} for ${inputPath}`);
  }
}

async function findVideoFiles(dir: string) {
  const files: string[] = [];

  async function walk(d: string) {
    const entries = await readdir(d, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(d, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (VIDEO_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        files.push(fullPath);
      }
    }
  }

  await walk(dir);
  return files;
}

function computeOutputPath(inputPath: string, dirVideoCount: Map<string, number>) {
  const rel = relative(INPUT_DIR, inputPath);
  const dir = dirname(rel);
  const normalizedName = normalizeFilename(basename(inputPath));

  const mp4Name = normalizedName.replace(/\.[^.]+$/, ".mp4");

  if (dir === ".") {
    return join(OUTPUT_DIR, mp4Name);
  }

  const inputDir = dirname(inputPath);
  const count = dirVideoCount.get(inputDir) ?? 0;

  if (count === 1) {
    return join(OUTPUT_DIR, mp4Name);
  }

  const normalizedDir = normalizeFilename(basename(dir) + ".dummy").replace(".dummy", "");
  return join(OUTPUT_DIR, normalizedDir, mp4Name);
}

async function scanAndProcess() {
  const files = await findVideoFiles(INPUT_DIR).catch((err) => {
    console.error("Failed to scan input directory:", err);
    return [] as string[];
  });

  if (files.length === 0) return;

  const fileTimes = await Promise.all(files.map(async (f) => ({ path: f, mtime: (await stat(f)).mtimeMs })));
  fileTimes.sort((a, b) => a.mtime - b.mtime);

  const dirVideoCount = new Map<string, number>();
  for (const file of files) {
    const dir = dirname(file);
    dirVideoCount.set(dir, (dirVideoCount.get(dir) ?? 0) + 1);
  }

  const jobs: { inputPath: string; outputPath: string }[] = [];
  for (const { path: inputPath } of fileTimes) {
    const outputPath = computeOutputPath(inputPath, dirVideoCount);

    const exists = await stat(outputPath).then(
      () => true,
      () => false,
    );
    if (exists) continue;

    await mkdir(dirname(outputPath), { recursive: true });
    jobs.push({ inputPath, outputPath });
  }

  for (let i = 0; i < jobs.length; i += PARALLEL_JOBS) {
    const batch = jobs.slice(i, i + PARALLEL_JOBS);
    const results = await Promise.all(batch.map(({ inputPath, outputPath }) => processFile(inputPath, outputPath)));
    for (const result of results) {
      if (result instanceof Error) console.error(result.message);
    }
  }
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let processing = false;

function scheduleProcess() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(async () => {
    if (processing) return;
    processing = true;
    await scanAndProcess();
    processing = false;
  }, DEBOUNCE_MS);
}

async function startWatching() {
  const ac = new AbortController();
  const watcher = watch(INPUT_DIR, { recursive: true, signal: ac.signal });
  for await (const event of watcher) {
    const filename = event.filename ?? "";
    if (VIDEO_EXTENSIONS.has(extname(filename).toLowerCase())) {
      console.log(`Change detected: ${filename}`);
      scheduleProcess();
    }
  }
}

console.log("Movie sync started");
console.log(`GPU: ${HAS_GPU ? "detected (using hevc_nvenc)" : "not detected (using libx265)"}`);
console.log(`Watching ${INPUT_DIR} → ${OUTPUT_DIR}`);
console.log(`fs.watch with ${POLL_INTERVAL / 1000}s fallback poll`);

await scanAndProcess();

// fs.watch as primary, polling as fallback
startWatching().catch((err) => {
  console.error("fs.watch failed, relying on polling only:", err);
});
setInterval(scheduleProcess, POLL_INTERVAL);
