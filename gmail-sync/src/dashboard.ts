import { timingSafeEqual } from "crypto";
import { and, asc, desc, eq, getTableColumns, gte, inArray, isNull, notInArray, or } from "drizzle-orm";
import express from "express";
import { db, getKv } from "./db";
import { exitOnError } from "./errors";
import { countQueued } from "./queue";
import { emailExtractions, logs, orderEvents, orders, type OrderStatus } from "./schema";

const PORT = Number(process.env.DASHBOARD_PORT ?? 8086);
const DEFAULT_WIDTH = 120;
const MIN_WIDTH = 30;
const MAX_WIDTH = 300;
const FINISHED_STATUSES: OrderStatus[] = ["delivered", "cancelled", "returned"];
const FINISHED_LOOKBACK_MS = 14 * 24 * 60 * 60_000;
const EMAILS_PER_ORDER = 4;
const DEFAULT_BACKFILL_DAYS = 30;
const MAX_BACKFILL_DAYS = 365;
const PLACEHOLDER = /^(n\/?a|none|null|unknown|-|\?)$/i;

export interface Backfill {
  start: (days: number) => Promise<number | null | Error>;
  progress: () => { running: boolean; done: number; total: number };
}

let backfillState: Backfill | undefined;
// The sync loop runs at least every 10 minutes, so a gap well beyond that means it is stuck.
const SYNC_WARN_MS = 20 * 60_000;
const SYNC_DOWN_MS = 60 * 60_000;
const WATCH_WARN_MS = 24 * 60 * 60_000;
const ERROR_WINDOW_MS = 60 * 60_000;

type Order = typeof orders.$inferSelect;
type EventRow = typeof orderEvents.$inferSelect & { durationMs: number | null };

function timeAgo(iso: string, now: number) {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function formatDuration(ms: number) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 1) return "<1s";
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m${seconds % 60}s` : `${seconds}s`;
}

const known = (value: string | null) => (value && !PLACEHOLDER.test(value.trim()) ? value.trim() : null);

function formatDate(value: string | null, now: number) {
  const text = known(value);
  if (!text) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  const sameYear = date.getUTCFullYear() === new Date(now).getUTCFullYear();
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: sameYear ? undefined : "numeric",
    timeZone: "UTC",
  });
}

const formatStatus = (status: OrderStatus | null) => (status ?? "unknown").replaceAll("_", " ");

const fit = (text: string, width: number) =>
  [...text].length <= width ? text : [...text].slice(0, width - 1).join("") + "…";

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

function spread(left: string, right: string, width: number) {
  const gap = width - [...left].length - [...right].length;
  return gap >= 2 ? [left + " ".repeat(gap) + right] : [fit(left, width), fit(`  ${right}`, width)];
}

function productLines(order: Order, width: number) {
  const quantities = new Map<string, number>();
  for (const item of order.items) {
    const name = known(item.name);
    if (name) quantities.set(name, (quantities.get(name) ?? 0) + (item.quantity ?? 1));
  }
  if (quantities.size === 0) return ["  - products unknown"];
  return [...quantities].flatMap(([name, quantity]) =>
    wrapLine(`${quantity > 1 ? `${quantity}x ` : ""}${name}`, Math.max(10, width - 4)).map(
      (line, i) => `${i === 0 ? "  - " : "    "}${line}`,
    ),
  );
}

function emailLine(event: EventRow, now: number, width: number) {
  const parsed = event.durationMs === null ? "" : `AI took ${formatDuration(event.durationMs)}`;
  return fit(`  ${timeAgo(event.at, now).padEnd(8)} email: ${formatStatus(event.status).padEnd(16)} ${parsed}`.trimEnd(), width);
}

function renderOrder(order: Order, events: EventRow[], now: number, width: number) {
  const reference = known(order.orderNumber) ?? known(order.trackingNumber);
  const eta = formatDate(order.estimatedDelivery, now);
  const left = `${known(order.merchant) ?? "Unknown shop"} · ${reference ? `order ${reference}` : "no order number"}`;
  const right = [formatStatus(order.status).toUpperCase(), ...(eta ? [`expected ${eta}`] : [])].join(" · ");
  return [
    ...spread(left, right, width),
    ...productLines(order, width),
    ...events.slice(-EMAILS_PER_ORDER).map((event) => emailLine(event, now, width)),
  ].join("\n");
}

function healthLines(now: number, width: number) {
  const lastSyncAt = getKv("lastSyncAt");
  const watchExpiration = Number(getKv("watchExpiration") ?? 0);
  const syncAge = lastSyncAt ? now - new Date(lastSyncAt).getTime() : Infinity;
  const recentErrors = db
    .select({ at: logs.at, message: logs.message })
    .from(logs)
    .where(and(eq(logs.level, "error"), gte(logs.at, new Date(now - ERROR_WINDOW_MS).toISOString())))
    .orderBy(desc(logs.at))
    .all();

  const down: string[] = [];
  const warn: string[] = [];
  if (!lastSyncAt) down.push("never synced with Gmail");
  else if (syncAge > SYNC_DOWN_MS) down.push(`last Gmail sync ${timeAgo(lastSyncAt, now)}`);
  else if (syncAge > SYNC_WARN_MS) warn.push(`last Gmail sync ${timeAgo(lastSyncAt, now)}`);
  if (watchExpiration < now) down.push("Gmail watch expired");
  else if (watchExpiration - now < WATCH_WARN_MS) warn.push("Gmail watch expires within a day");
  if (recentErrors.length > 0) warn.push(`${recentErrors.length} error${recentErrors.length === 1 ? "" : "s"} in the last hour`);

  const progress = backfillState?.progress();
  const queued = countQueued("new", "reparse");
  const info = [
    ...(queued > 0 ? [`${queued} email${queued === 1 ? "" : "s"} waiting for the AI`] : []),
    ...(progress?.running ? [`backfill ${progress.done} of ${progress.total} emails done`] : []),
  ];

  let level = "OK";
  if (warn.length) level = "WARN";
  if (down.length) level = "DOWN";
  const problems = [...down, ...warn];
  const summary = [...(problems.length ? problems : [`synced with Gmail ${timeAgo(lastSyncAt!, now)}`]), ...info];
  const lines = wrapLine(`${level}: ${summary.join(" · ")}`, width);
  const latest = recentErrors[0];
  if (latest) lines.push(fit(`Latest error ${timeAgo(latest.at, now)}: ${latest.message.split("\n")[0]}`, width));
  return lines;
}

function renderDashboard(width: number) {
  const now = Date.now();
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
    .orderBy(asc(orders.updatedAt))
    .all();
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
    .orderBy(asc(orderEvents.at))
    .all();

  const blocks = visibleOrders.map((order) =>
    renderOrder(
      order,
      events.filter((event) => event.orderId === order.id),
      now,
      width,
    ),
  );
  return [...(blocks.length ? blocks : ["No orders yet"]), healthLines(now, width).join("\n")].join("\n\n") + "\n";
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
      const { done, total } = backfill.progress();
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
