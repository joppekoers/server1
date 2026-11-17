import { timingSafeEqual } from "crypto";
import { and, count, desc, eq, gte, isNull, notInArray, or } from "drizzle-orm";
import express from "express";
import { db, getKv } from "./db";
import { logs, orders, type OrderStatus } from "./schema";

const PORT = Number(process.env.DASHBOARD_PORT ?? 8086);
const DEFAULT_WIDTH = 120;
const MIN_WIDTH = 30;
const MAX_WIDTH = 300;
const FINISHED_STATUSES: OrderStatus[] = ["delivered", "cancelled", "returned"];
const FINISHED_LOOKBACK_MS = 14 * 24 * 60 * 60_000;
const COLUMN_GAP = "  ";
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
  { title: "SHOP", maxWidth: 18, dropOrder: 5, value: (order) => order.merchant ?? "?" },
  { title: "ORDER", maxWidth: 18, dropOrder: 2, value: (order) => order.orderNumber ?? order.trackingNumber ?? "?" },
  {
    title: "PRODUCTS",
    maxWidth: Infinity,
    flexible: true,
    dropOrder: 1,
    value: (order) =>
      order.items
        .map((item) => `${item.quantity && item.quantity > 1 ? `${item.quantity}x ` : ""}${item.name ?? item.sku}`)
        .join(", ") || "-",
  },
  { title: "STATUS", maxWidth: 16, dropOrder: 6, value: (order) => (order.status ?? "unknown").replaceAll("_", " ") },
  { title: "ETA", maxWidth: 10, dropOrder: 3, value: (order) => order.estimatedDelivery ?? "-" },
  { title: "UPDATED", maxWidth: 8, dropOrder: 4, value: (order, now) => timeAgo(order.updatedAt, now) },
];

const fit = (text: string, width: number) =>
  [...text].length <= width ? text.padEnd(width) : [...text].slice(0, width - 1).join("") + "…";

function renderTable(rows: string[][], columns: Column[], width: number) {
  const widths = columns.map((column, i) =>
    Math.min(column.maxWidth, Math.max(column.title.length, ...rows.map((row) => [...row[i]].length))),
  );
  const flexIndex = columns.findIndex((column) => column.flexible);
  const fixedWidth = widths.reduce((sum, w, i) => (i === flexIndex ? sum : sum + w), 0);
  const available = width - fixedWidth - COLUMN_GAP.length * (columns.length - 1);
  const fits = flexIndex >= 0 ? available >= columns[flexIndex].title.length : available >= 0;

  if (flexIndex >= 0 && fits) widths[flexIndex] = Math.min(widths[flexIndex], available);
  if (!fits && columns.length > 1) {
    const dropped = columns.reduce((lowest, column) => (column.dropOrder < lowest.dropOrder ? column : lowest));
    const keep = columns.map((column) => column !== dropped);
    return renderTable(
      rows.map((row) => row.filter((_, i) => keep[i])),
      columns.filter((_, i) => keep[i]),
      width,
    );
  }

  const line = (cells: string[]) => cells.map((cell, i) => fit(cell, widths[i])).join(COLUMN_GAP).trimEnd().slice(0, width);
  return [line(columns.map((column) => column.title)), ...rows.map(line)].join("\n");
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

  if (down.length) return ["DOWN", ...down, ...warn].join(" · ");
  if (warn.length) return ["WARN", ...warn].join(" · ");
  return `OK · synced ${timeAgo(lastSyncAt!, now)}`;
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
  const rows = visibleOrders.map((order) => COLUMNS.map((column) => column.value(order, now)));
  return `${status}\n${renderTable(rows, COLUMNS, width)}\n`;
}

function isAuthorized(header: string | undefined, token: string) {
  const provided = Buffer.from(header?.replace(/^Bearer /, "") ?? "");
  const expected = Buffer.from(token);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function startDashboard(token: string) {
  const app = express();
  app.set("etag", false);

  app.get("/dashboard/terminal", (req, res) => {
    res.type("text/plain; charset=utf-8");
    res.set("Cache-Control", "no-store");
    if (!isAuthorized(req.get("authorization"), token)) {
      res.status(401).send("Unauthorized\n");
      return;
    }
    const requested = Number(req.query.width ?? DEFAULT_WIDTH);
    const width = Number.isFinite(requested) ? Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.floor(requested))) : DEFAULT_WIDTH;
    res.send(renderDashboard(width));
  });

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("Dashboard request failed:", error);
    res.status(500).type("text/plain; charset=utf-8").send("Internal error, see logs\n");
  });

  app.listen(PORT, (error) => {
    if (error) throw error;
    console.log(`Dashboard listening on port ${PORT}`);
  });
}
