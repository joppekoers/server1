import { asc, count, eq, inArray, sql } from "drizzle-orm";
import { db } from "./db";
import { queue, type QueueSource } from "./schema";

export function enqueue(messageIds: string[], source: QueueSource) {
  const enqueuedAt = new Date().toISOString();
  return db.transaction(
    () =>
      messageIds.filter(
        (messageId) =>
          db.insert(queue).values({ messageId, source, enqueuedAt }).onConflictDoNothing().returning({ id: queue.id }).get(),
      ).length,
  );
}

export const nextQueued = () =>
  db
    .select()
    .from(queue)
    .orderBy(sql`${queue.source} != 'new'`, asc(queue.id))
    .limit(1)
    .get();

export const dequeue = (messageId: string) => db.delete(queue).where(eq(queue.messageId, messageId)).run();

export const countQueued = (...sources: QueueSource[]) =>
  db.select({ n: count() }).from(queue).where(inArray(queue.source, sources)).get()?.n ?? 0;

// Backfill and re-parse process emails out of order, so orders are rebuilt once none of them are left.
export const hasPendingRebuild = () => countQueued("backfill", "reparse") > 0;
