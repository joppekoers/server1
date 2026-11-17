import { createHash } from "crypto";
import { asc, eq, isNull, ne, or } from "drizzle-orm";
import { db, type StoredEmail } from "./db";
import { attempt, HttpError, parseJson, toError } from "./errors";
import { dequeue, enqueue, hasPendingRebuild } from "./queue";
import {
  emailExtractions,
  emails,
  ORDER_STATUSES,
  orderEvents,
  orders,
  type Extraction,
  type OrderItem,
  type OrderStatus,
  type QueueSource,
} from "./schema";

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const MODEL = process.env.OLLAMA_MODEL ?? "qwen3:8b";
const KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE ?? "1m";
const MAX_BODY_CHARS = 8000;
const MODEL_OPTIONS = { temperature: 0 };
const NOT_AN_ORDER = /"isOrderEmail"\s*:\s*false/;

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

const nullableString = { type: ["string", "null"] };

const EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    isOrderEmail: { type: "boolean" },
    merchant: nullableString,
    orderNumber: nullableString,
    status: { type: ["string", "null"], enum: [...ORDER_STATUSES, null] },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: { name: nullableString, sku: nullableString, quantity: { type: ["integer", "null"] } },
        required: ["name", "sku", "quantity"],
      },
    },
    carrier: nullableString,
    trackingNumber: nullableString,
    trackingUrl: nullableString,
    estimatedDelivery: nullableString,
  },
  required: [
    "isOrderEmail", "merchant", "orderNumber", "status", "items",
    "carrier", "trackingNumber", "trackingUrl", "estimatedDelivery",
  ],
};

const SYSTEM_PROMPT = `You classify emails about online orders and parcel deliveries.
Set isOrderEmail to true only for transactional emails about a specific order or shipment: order confirmations, shipping notifications, tracking codes, out-for-delivery, delivered, delay, cancellation or return notices. Newsletters, promotions, reviews requests and receipts for in-store purchases are false.
status meanings: ordered = order placed/confirmed, shipped = handed to carrier or tracking code sent, out_for_delivery = arriving today, delivered, delayed, cancelled, returned.
items lists every product in the order. name is the product name as a shopper would say it (e.g. "Oversized Cotton T-Shirt - Black, M"), never an article number, SKU or code; if the email only shows codes, name is null. sku is the article/product code if shown. quantity is the number ordered.
Copy order numbers, tracking numbers and URLs exactly as written. Use null for anything not stated. estimatedDelivery is an ISO date (YYYY-MM-DD) or null.`;

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

function htmlToText(html: string) {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

function userMessage(email: StoredEmail) {
  const body = (email.text.trim() || htmlToText(email.html)).slice(0, MAX_BODY_CHARS);
  return `From: ${email.from}\nSubject: ${email.subject}\nReceived: ${email.receivedAt}\n\n${body}`;
}

// Anything that can change the model output is hashed, so editing the prompt, schema or input formatting re-parses stored emails.
export const EXTRACTION_VERSION = createHash("sha256")
  .update(
    JSON.stringify([MODEL, MODEL_OPTIONS, SYSTEM_PROMPT, EXTRACTION_SCHEMA, htmlToText.toString(), userMessage.toString()]),
  )
  .digest("hex")
  .slice(0, 16);

async function readChatStream(body: ReadableStream<Uint8Array>): Promise<string | Error> {
  let content = "";
  let buffered = "";
  const decoder = new TextDecoder();
  const append = (line: string) => {
    const chunk = parseJson<{ message?: { content: string } }>(line);
    if (chunk instanceof Error) return chunk;
    content += chunk.message?.content ?? "";
  };

  try {
    for await (const bytes of body) {
      buffered += decoder.decode(bytes, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop()!;
      for (const line of lines.filter(Boolean)) {
        const appended = append(line);
        if (appended instanceof Error) return appended;
      }
      // isOrderEmail is the first schema property, so on "false" leaving the loop cancels the stream and Ollama stops generating.
      if (NOT_AN_ORDER.test(content)) return content;
    }
  } catch (error) {
    return toError(error);
  }
  if (buffered.trim()) {
    const appended = append(buffered);
    if (appended instanceof Error) return appended;
  }
  return content;
}

async function extract(email: StoredEmail): Promise<Extraction | null | Error> {
  const res = await attempt(
    fetch(`${OLLAMA_URL}/api/chat`, {
      timeout: false,
      method: "POST",
      body: JSON.stringify({
        model: MODEL,
        stream: true,
        think: false,
        keep_alive: KEEP_ALIVE,
        format: EXTRACTION_SCHEMA,
        options: MODEL_OPTIONS,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMessage(email) },
        ],
      }),
    }),
  );
  if (res instanceof Error) return res;
  if (!res.ok || !res.body) return new HttpError(`Ollama ${res.status}: ${await attempt(res.text())}`, res.status);

  const content = await readChatStream(res.body);
  if (content instanceof Error) return content;
  if (NOT_AN_ORDER.test(content)) return null;
  return parseJson<Extraction>(content);
}

async function timedExtract(email: StoredEmail) {
  const started = performance.now();
  const result = await extract(email);
  if (result instanceof Error) return result;
  return { result, durationMs: Math.round(performance.now() - started) };
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
