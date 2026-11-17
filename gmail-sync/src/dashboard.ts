import { timingSafeEqual } from "crypto";
import { and, count, desc, eq, getTableColumns, gte, inArray, isNull, notInArray, or } from "drizzle-orm";
import express from "express";
import { db, getKv } from "./db";
import { exitOnError } from "./errors";
import { emailExtractions, logs, orderEvents, orders, type OrderStatus } from "./schema";

const PORT = Number(process.env.DASHBOARD_PORT ?? 8086);
const DEFAULT_WIDTH = 120;
const MIN_WIDTH = 30;
const MAX_WIDTH = 300;
const FINISHED_STATUSES: OrderStatus[] = ["delivered", "cancelled", "returned"];
const FINISHED_LOOKBACK_MS = 14 * 24 * 60 * 60_000;
const COLUMN_GAP = "  ";
const MIN_PRODUCTS_WIDTH = 20;
const EMAILS_PER_ORDER = 4;
const DEFAULT_BACKFILL_DAYS = 30;
const MAX_BACKFILL_DAYS = 365;

export interface Backfill {
  start: (days: number) => Promise<number | null | Error>;
  progress: { running: boolean; done: number; total: number };
}

let backfillState: Backfill | undefined;
// The sync loop runs at least every 10 minutes, so a gap well beyond that means it is stuck.
const SYNC_WARN_MS = 20 * 60_000;
const SYNC_DOWN_MS = 60 * 60_000;
const WATCH_WARN_MS = 24 * 60 * 60_000;
const ERROR_WINDOW_MS = 60 * 60_000;

interface Column {
  title: string;
  maxWidth: number;
  flexible?: boolean;
  dropOrder: number;
  value: (order: typeof orders.$inferSelect, now: number) => string;
}

function timeAgo(iso: string, now: number) {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

const COLUMNS: Column[] = [
  { title: "SHOP", maxWidth: 14, dropOrder: 5, value: (order) => order.merchant ?? "?" },
  { title: "ORDER", maxWidth: 14, dropOrder: 1, value: (order) => order.orderNumber ?? order.trackingNumber ?? "?" },
  {
    title: "PRODUCTS",
    maxWidth: Infinity,
    flexible: true,
    dropOrder: 3,
    value: (order) =>
      order.items
        .filter((item) => item.name)
        .map((item) => `${item.quantity && item.quantity > 1 ? `${item.quantity}x ` : ""}${item.name}`)
        .join("\n") || "-",
  },
  { title: "STATUS", maxWidth: 16, dropOrder: 6, value: (order) => (order.status ?? "unknown").replaceAll("_", " ") },
  { title: "ETA", maxWidth: 10, dropOrder: 2, value: (order) => order.estimatedDelivery ?? "-" },
  { title: "UPDATED", maxWidth: 8, dropOrder: 4, value: (order, now) => timeAgo(order.updatedAt, now) },
];

const fit = (text: string, width: number) =>
  [...text].length <= width ? text.padEnd(width) : [...text].slice(0, width - 1).join("") + "…";

const cellWidth = (text: string) => Math.max(...text.split("\n").map((line) => [...line].length));

const wrapCell = (text: string, width: number) => text.split("\n").flatMap((line) => wrapLine(line, width));

function wrapLine(text: string, width: number) {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    for (let rest = [...word]; rest.length > 0; ) {
      const room = width - [...line].length - (line ? 1 : 0);
      if (rest.length <= room) {
        line += (line ? " " : "") + rest.join("");
        rest = [];
      } else if (line) {
        lines.push(line);
        line = "";
      } else {
        lines.push(rest.slice(0, width).join(""));
        rest = rest.slice(width);
      }
    }
  }
  if (line || lines.length === 0) lines.push(line);
  return lines;
}

function renderTable(rows: string[][], columns: Column[], width: number, extras: string[][]): string {
  const widths = columns.map((column, i) =>
    Math.min(column.maxWidth, Math.max(column.title.length, ...rows.map((row) => cellWidth(row[i])))),
  );
  const flexIndex = columns.findIndex((column) => column.flexible);
  const fixedWidth = widths.reduce((sum, w, i) => (i === flexIndex ? sum : sum + w), 0);
  const available = width - fixedWidth - COLUMN_GAP.length * (columns.length - 1);
  const fits = flexIndex >= 0 ? available >= MIN_PRODUCTS_WIDTH : available >= 0;

  if (flexIndex >= 0 && fits) widths[flexIndex] = Math.min(widths[flexIndex], available);
  if (!fits && columns.length > 1) {
    const dropped = columns.reduce((lowest, column) => (column.dropOrder < lowest.dropOrder ? column : lowest));
    const keep = columns.map((column) => column !== dropped);
    return renderTable(
      rows.map((row) => row.filter((_, i) => keep[i])),
      columns.filter((_, i) => keep[i]),
      width,
      extras,
    );
  }

  const header = columns.map((column, i) => fit(column.title, widths[i])).join(COLUMN_GAP).trimEnd();
  const indent = " ".repeat(widths[0] + COLUMN_GAP.length);
  const rowLines = (cells: string[], rowIndex: number) => {
    const wrapped = cells.map((cell, i) => wrapCell(cell, widths[i]));
    const height = Math.max(...wrapped.map((lines) => lines.length));
    const lines = Array.from({ length: height }, (_, lineIndex) =>
      wrapped.map((lines, i) => fit(lines[lineIndex] ?? "", widths[i])).join(COLUMN_GAP).trimEnd(),
    );
    const extraLines = extras[rowIndex].map((extra) =>
      indent.length + [...extra].length <= width ? indent + extra : fit(extra, width).trimEnd(),
    );
    return [...lines, ...extraLines];
  };
  return [header, ...rows.flatMap(rowLines)].join("\n");
}

function formatDuration(ms: number | null) {
  if (ms === null) return "-";
  const seconds = Math.round(ms / 1000);
  if (seconds < 1) return "<1s";
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m${seconds % 60}s` : `${seconds}s`;
}

type EventRow = typeof orderEvents.$inferSelect & { durationMs: number | null };

function emailLine(event: EventRow, now: number) {
  const status = (event.status ?? "-").replaceAll("_", " ").padEnd(16);
  return `${status}  ${timeAgo(event.at, now).padEnd(8)}  ${formatDuration(event.durationMs).padStart(6)}`;
}

function healthLine(now: number) {
  const lastSyncAt = getKv("lastSyncAt");
  const watchExpiration = Number(getKv("watchExpiration") ?? 0);
  const syncAge = lastSyncAt ? now - new Date(lastSyncAt).getTime() : Infinity;
  const recentErrors =
    db
      .select({ n: count() })
      .from(logs)
      .where(and(eq(logs.level, "error"), gte(logs.at, new Date(now - ERROR_WINDOW_MS).toISOString())))
      .get()?.n ?? 0;

  const down: string[] = [];
  const warn: string[] = [];
  if (!lastSyncAt) down.push("never synced");
  else if (syncAge > SYNC_DOWN_MS) down.push(`last sync ${timeAgo(lastSyncAt, now)}`);
  else if (syncAge > SYNC_WARN_MS) warn.push(`last sync ${timeAgo(lastSyncAt, now)}`);
  if (watchExpiration < now) down.push("gmail watch expired");
  else if (watchExpiration - now < WATCH_WARN_MS) warn.push("gmail watch expires within a day");
  if (recentErrors > 0) warn.push(`${recentErrors} error${recentErrors === 1 ? "" : "s"} in last hour`);

  const progress = backfillState?.progress;
  const info = progress?.running ? [`backfill ${progress.done}/${progress.total}`] : [];

  if (down.length) return ["DOWN", ...down, ...warn, ...info].join(" · ");
  if (warn.length) return ["WARN", ...warn, ...info].join(" · ");
  return ["OK", `synced ${timeAgo(lastSyncAt!, now)}`, ...info].join(" · ");
}

function renderDashboard(width: number) {
  const now = Date.now();
  const status = fit(healthLine(now), width).trimEnd();
  const visibleOrders = db
    .select()
    .from(orders)
    .where(
      or(
        isNull(orders.status),
        notInArray(orders.status, FINISHED_STATUSES),
        gte(orders.updatedAt, new Date(now - FINISHED_LOOKBACK_MS).toISOString()),
      ),
    )
    .orderBy(desc(orders.updatedAt))
    .all();

  if (visibleOrders.length === 0) return `${status}\nNo orders yet\n`;
  const events = db
    .select({ ...getTableColumns(orderEvents), durationMs: emailExtractions.durationMs })
    .from(orderEvents)
    .leftJoin(emailExtractions, eq(emailExtractions.emailId, orderEvents.emailId))
    .where(
      inArray(
        orderEvents.orderId,
        visibleOrders.map((order) => order.id),
      ),
    )
    .orderBy(desc(orderEvents.at))
    .all();
  const rows = visibleOrders.map((order) => COLUMNS.map((column) => column.value(order, now)));
  const extras = visibleOrders.map((order) =>
    events
      .filter((event) => event.orderId === order.id)
      .slice(0, EMAILS_PER_ORDER)
      .map((event) => emailLine(event, now)),
  );
  return `${status}\n${renderTable(rows, COLUMNS, width, extras)}\n`;
}

function isAuthorized(header: string | undefined, token: string) {
  const provided = Buffer.from(header?.replace(/^Bearer /, "") ?? "");
  const expected = Buffer.from(token);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function clampedNumber(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.floor(parsed))) : fallback;
}

export function startDashboard(token: string, backfill: Backfill) {
  backfillState = backfill;
  const app = express();
  app.set("etag", false);

  app.use((req, res, next) => {
    res.type("text/plain; charset=utf-8");
    res.set("Cache-Control", "no-store");
    if (!isAuthorized(req.get("authorization"), token)) {
      res.status(401).send("Unauthorized\n");
      return;
    }
    next();
  });

  app.get("/dashboard/terminal", (req, res) => {
    res.send(renderDashboard(clampedNumber(req.query.width, DEFAULT_WIDTH, MIN_WIDTH, MAX_WIDTH)));
  });

  app.post("/backfill", async (req, res) => {
    const days = clampedNumber(req.query.days, DEFAULT_BACKFILL_DAYS, 1, MAX_BACKFILL_DAYS);
    const queued = await backfill.start(days);
    if (queued instanceof Error) {
      console.error("Backfill could not start:", queued);
      res.status(502).send(`Backfill could not start: ${queued.message}\n`);
      return;
    }
    if (queued === null) {
      const { done, total } = backfill.progress;
      res.status(409).send(`Backfill already running (${done}/${total})\n`);
      return;
    }
    res.status(202).send(`Backfill of the last ${days} days started: ${queued} new emails to parse\n`);
  });

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("Dashboard request failed:", error);
    res.status(500).type("text/plain; charset=utf-8").send("Internal error, see logs\n");
  });

  app.listen(PORT, (error) => {
    if (error) exitOnError(error);
    console.log(`Dashboard listening on port ${PORT}`);
  });
}
