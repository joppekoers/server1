import { existsSync, mkdirSync, readdirSync, renameSync } from "fs";
import { basename, join } from "path";
import { db, insertEmail, setKv, type StoredEmail } from "./db";
import { logs } from "./schema";
import { saveOrder, saveOrderEvent, toOrderItem, type Order, type OrderEvent } from "./orders";

const DATA_DIR = process.env.DATA_DIR ?? "./data";
const LEGACY_DIR = join(DATA_DIR, "legacy-json");
const EMAILS_DIR = join(DATA_DIR, "emails");
const ORDERS_FILE = join(DATA_DIR, "orders.json");
const STATE_FILE = join(DATA_DIR, "state.json");
const TOKEN_FILE = join(DATA_DIR, "token.json");
const LOG_FILE = join(DATA_DIR, "app.log");
const LOG_LINE_START = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z) (LOG|INFO|WARN|ERROR) /m;

function parseLegacyLog(content: string) {
  const parts = content.split(LOG_LINE_START).slice(1);
  const entries: (typeof logs.$inferInsert)[] = [];
  for (let i = 0; i < parts.length; i += 3) {
    const level = parts[i + 1].toLowerCase() as (typeof logs.$inferInsert)["level"];
    entries.push({ at: parts[i], level, message: parts[i + 2].trimEnd() });
  }
  return entries;
}

const readJson = async <T>(path: string): Promise<T | null> => (existsSync(path) ? Bun.file(path).json() : null);

export async function migrateLegacyJson() {
  const sources = [EMAILS_DIR, ORDERS_FILE, STATE_FILE, TOKEN_FILE, LOG_FILE].filter((path) => existsSync(path));
  if (sources.length === 0) return;

  const emails = existsSync(EMAILS_DIR)
    ? await Promise.all(
        readdirSync(EMAILS_DIR)
          .filter((name) => name.endsWith(".json"))
          .map((name) => Bun.file(join(EMAILS_DIR, name)).json() as Promise<StoredEmail>),
      )
    : [];
  const orders = (await readJson<(Omit<Order, "items"> & { items: string[]; history: OrderEvent[] })[]>(ORDERS_FILE)) ?? [];
  const state = await readJson<{ historyId?: string; watchExpiration?: number }>(STATE_FILE);
  const token = await readJson<{ refresh_token?: string }>(TOKEN_FILE);
  const logEntries = existsSync(LOG_FILE) ? parseLegacyLog(await Bun.file(LOG_FILE).text()) : [];

  db.transaction(() => {
    emails.forEach(insertEmail);
    for (const { history, items, ...order } of orders) {
      const orderId = saveOrder({ ...order, items: items.map(toOrderItem) });
      history.forEach((event) => saveOrderEvent(orderId, event));
    }
    if (state?.historyId) setKv("historyId", state.historyId);
    if (state?.watchExpiration) setKv("watchExpiration", String(state.watchExpiration));
    if (token?.refresh_token) setKv("refreshToken", token.refresh_token);
    for (const entry of logEntries) db.insert(logs).values(entry).run();
  });

  mkdirSync(LEGACY_DIR, { recursive: true });
  for (const path of sources) renameSync(path, join(LEGACY_DIR, basename(path)));
  console.log(
    `Migrated ${emails.length} emails, ${orders.length} orders and ${logEntries.length} log lines into SQLite`,
  );
}
