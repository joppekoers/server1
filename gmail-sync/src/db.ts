import { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { mkdirSync } from "fs";
import { join } from "path";
import * as schema from "./schema";

const DATA_DIR = process.env.DATA_DIR ?? "./data";
mkdirSync(DATA_DIR, { recursive: true });

const sqlite = new Database(join(DATA_DIR, "gmail-sync.db"), { create: true });
sqlite.run("PRAGMA journal_mode = WAL");
sqlite.run("PRAGMA foreign_keys = ON");

export const db = drizzle(sqlite, { schema });
migrate(db, { migrationsFolder: join(import.meta.dir, "..", "drizzle") });

export interface StoredEmail {
  id: string;
  threadId: string;
  labelIds?: string[];
  receivedAt: string;
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  snippet: string;
  text: string;
  html: string;
  attachments: string[];
  headers?: { name: string; value: string }[];
}

export const getKv = (key: string) =>
  db.select({ value: schema.kv.value }).from(schema.kv).where(eq(schema.kv.key, key)).get()?.value;

export const setKv = (key: string, value: string) =>
  db.insert(schema.kv).values({ key, value }).onConflictDoUpdate({ target: schema.kv.key, set: { value } }).run();

export const emailExists = (id: string) =>
  db.select({ id: schema.emails.id }).from(schema.emails).where(eq(schema.emails.id, id)).get() !== undefined;

export function insertEmail(email: StoredEmail) {
  db.insert(schema.emails)
    .values({
      id: email.id,
      threadId: email.threadId,
      receivedAt: email.receivedAt,
      fromAddress: email.from,
      toAddress: email.to,
      cc: email.cc,
      subject: email.subject,
      snippet: email.snippet,
      text: email.text,
      html: email.html,
      labelIds: email.labelIds ?? [],
      attachments: email.attachments,
      headers: email.headers ?? [],
    })
    .onConflictDoNothing()
    .run();
}
