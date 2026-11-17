import { eq, or } from "drizzle-orm";
import { db, insertEmail, type StoredEmail } from "./db";
import { ORDER_STATUSES, orderEvents, orders, type OrderItem, type OrderStatus } from "./schema";

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const MODEL = process.env.OLLAMA_MODEL ?? "qwen3:8b";
const KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE ?? "1m";
const MAX_BODY_CHARS = 8000;

interface Extraction {
  isOrderEmail: boolean;
  merchant: string | null;
  orderNumber: string | null;
  status: OrderStatus | null;
  items: OrderItem[];
  carrier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  estimatedDelivery: string | null;
}

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
items lists every product in the order: name is the human-readable product name (e.g. "Oversized Cotton T-Shirt - Black, M"), sku is the article/product code if shown, quantity is the number ordered.
Copy order numbers, tracking numbers and URLs exactly as written. Use null for anything not stated. estimatedDelivery is an ISO date (YYYY-MM-DD) or null.`;

export async function ensureModel() {
  console.log(`Pulling ${MODEL} (no-op when already present)`);
  const res = await fetch(`${OLLAMA_URL}/api/pull`, {
    timeout: false,
    method: "POST",
    body: JSON.stringify({ model: MODEL, stream: false }),
  });
  if (!res.ok) throw new Error(`Ollama pull ${res.status}: ${await res.text()}`);
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

async function extract(email: StoredEmail): Promise<Extraction | null> {
  const body = (email.text.trim() || htmlToText(email.html)).slice(0, MAX_BODY_CHARS);
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    timeout: false,
    method: "POST",
    body: JSON.stringify({
      model: MODEL,
      stream: true,
      think: false,
      keep_alive: KEEP_ALIVE,
      format: EXTRACTION_SCHEMA,
      options: { temperature: 0 },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `From: ${email.from}\nSubject: ${email.subject}\nReceived: ${email.receivedAt}\n\n${body}` },
      ],
    }),
  });
  if (!res.ok || !res.body) throw new Error(`Ollama ${res.status}: ${await res.text()}`);

  let content = "";
  let buffered = "";
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buffered += decoder.decode(chunk, { stream: true });
    const lines = buffered.split("\n");
    buffered = lines.pop()!;
    for (const line of lines.filter(Boolean)) {
      content += (JSON.parse(line) as { message?: { content: string } }).message?.content ?? "";
    }
    // isOrderEmail is the first schema property, so on "false" leaving the loop cancels the stream and Ollama stops generating.
    if (/"isOrderEmail"\s*:\s*false/.test(content)) return null;
  }
  if (buffered.trim()) content += (JSON.parse(buffered) as { message?: { content: string } }).message?.content ?? "";
  if (/"isOrderEmail"\s*:\s*false/.test(content)) return null;
  return JSON.parse(content);
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

function applyExtraction(email: StoredEmail, extraction: Extraction | null) {
  if (!extraction?.isOrderEmail ||(!extraction.orderNumber && !extraction.trackingNumber)) return;

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
  console.log(`Order ${order.merchant ?? "?"} ${order.orderNumber ?? order.trackingNumber}: ${order.status}`);
}

export async function processEmail(email: StoredEmail) {
  const extraction = await extract(email);
  db.transaction(() => {
    applyExtraction(email, extraction);
    insertEmail(email);
  });
}
