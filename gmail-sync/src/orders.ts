import { asc, eq, isNull, ne, or } from "drizzle-orm";
import { db, type StoredEmail } from "./db";
import { attempt, HttpError } from "./errors";
import { EXTRACTION_VERSION, MODEL, OLLAMA_URL, timedExtract } from "./extraction";
import { dequeue, enqueue, hasPendingRebuild } from "./queue";
import {
  emailExtractions,
  emails,
  orderEvents,
  orders,
  type Extraction,
  type OrderItem,
  type OrderStatus,
  type QueueSource,
} from "./schema";

export interface Order {
  id?: number;
  merchant: string | null;
  orderNumber: string | null;
  status: OrderStatus | null;
  items: OrderItem[];
  carrier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  estimatedDelivery: string | null;
  updatedAt: string;
}

export interface OrderEvent {
  status: OrderStatus | null;
  at: string;
  emailId: string;
  subject?: string;
}

type EmailRef = Pick<StoredEmail, "id" | "receivedAt" | "subject">;


// Ollama has no internet access, so a missing model has to be pulled by hand (see README).
export async function ensureModel() {
  const res = await attempt(
    fetch(`${OLLAMA_URL}/api/show`, { method: "POST", body: JSON.stringify({ model: MODEL }) }),
  );
  if (res instanceof Error) return res;
  if (res.status === 404) return new Error(`Model ${MODEL} is not available in Ollama, pull it first (see README)`);
  if (!res.ok) return new HttpError(`Ollama show ${res.status}: ${await attempt(res.text())}`, res.status);
  console.log(`Using model ${MODEL}`);
}


export const toOrderItem = (item: OrderItem | string): OrderItem =>
  typeof item === "string" ? { name: item, sku: null, quantity: null } : item;

const normalize = (value: string | null) => value?.toLowerCase().replace(/[^a-z0-9]/g, "") || null;

function findOrder(orderNumber: string | null, trackingNumber: string | null): Order | null {
  const orderNumberKey = normalize(orderNumber);
  const trackingNumberKey = normalize(trackingNumber);
  if (!orderNumberKey && !trackingNumberKey) return null;
  return (
    db
      .select()
      .from(orders)
      .where(
        or(
          orderNumberKey ? eq(orders.orderNumberKey, orderNumberKey) : undefined,
          trackingNumberKey ? eq(orders.trackingNumberKey, trackingNumberKey) : undefined,
        ),
      )
      .limit(1)
      .get() ?? null
  );
}

export function saveOrder({ id, ...order }: Order) {
  const values = {
    ...order,
    orderNumberKey: normalize(order.orderNumber),
    trackingNumberKey: normalize(order.trackingNumber),
  };
  if (id) {
    db.update(orders).set(values).where(eq(orders.id, id)).run();
    return id;
  }
  return db.insert(orders).values(values).returning({ id: orders.id }).get().id;
}

export function saveOrderEvent(orderId: number, event: OrderEvent) {
  db.insert(orderEvents).values({ orderId, ...event }).onConflictDoNothing().run();
}

function saveExtraction(emailId: string, result: Extraction | null, durationMs: number) {
  const values = { version: EXTRACTION_VERSION, result, durationMs, extractedAt: new Date().toISOString() };
  db.insert(emailExtractions)
    .values({ emailId, ...values })
    .onConflictDoUpdate({ target: emailExtractions.emailId, set: values })
    .run();
}

function applyExtraction(email: EmailRef, extraction: Extraction | null) {
  if (!extraction?.isOrderEmail || (!extraction.orderNumber && !extraction.trackingNumber)) return null;

  const order: Order = findOrder(extraction.orderNumber, extraction.trackingNumber) ?? {
    merchant: null, orderNumber: null, status: null, items: [], carrier: null,
    trackingNumber: null, trackingUrl: null, estimatedDelivery: null, updatedAt: email.receivedAt,
  };

  // Emails can be processed out of order during catch-up, so an older email only fills in missing fields.
  const isNewer = email.receivedAt >= order.updatedAt;
  const { isOrderEmail, items, status, ...fields } = extraction;
  const target = order as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(fields)) {
    if (value !== null && (isNewer || target[key] === null)) target[key] = value;
  }
  if (items.length > 0 && (isNewer || order.items.length === 0)) order.items = items;

  if (status && isNewer) {
    order.status = status;
    order.updatedAt = email.receivedAt;
  }

  const orderId = saveOrder(order);
  saveOrderEvent(orderId, { status, at: email.receivedAt, emailId: email.id, subject: email.subject });
  return order;
}

export async function processQueuedEmail(email: StoredEmail, source: QueueSource) {
  const extraction = await timedExtract(email);
  if (extraction instanceof Error) return extraction;
  const order = db.transaction(() => {
    saveExtraction(email.id, extraction.result, extraction.durationMs);
    dequeue(email.id);
    return applyExtraction(email, extraction.result);
  });
  if (order) console.log(`Order ${order.merchant ?? "?"} ${order.orderNumber ?? order.trackingNumber}: ${order.status}`);
  if (source !== "new" && !hasPendingRebuild()) {
    rebuildOrders();
    console.log("Backfill and re-parse queue empty, rebuilt orders");
  }
}

export function rebuildOrders() {
  const extracted = db
    .select({
      id: emails.id,
      receivedAt: emails.receivedAt,
      subject: emails.subject,
      result: emailExtractions.result,
    })
    .from(emailExtractions)
    .innerJoin(emails, eq(emails.id, emailExtractions.emailId))
    .orderBy(asc(emails.receivedAt))
    .all();

  db.transaction(() => {
    db.delete(orderEvents).run();
    db.delete(orders).run();
    for (const { result, subject, ...email } of extracted) applyExtraction({ ...email, subject: subject ?? undefined }, result);
  });
}

export function enqueueStaleEmails() {
  const stale = db
    .select({ id: emails.id })
    .from(emails)
    .leftJoin(emailExtractions, eq(emails.id, emailExtractions.emailId))
    .where(or(isNull(emailExtractions.version), ne(emailExtractions.version, EXTRACTION_VERSION)))
    .orderBy(asc(emails.receivedAt))
    .all();
  const queued = enqueue(
    stale.map((row) => row.id),
    "reparse",
  );
  if (queued > 0) console.log(`Queued ${queued} emails for re-parsing with extraction version ${EXTRACTION_VERSION}`);
}
