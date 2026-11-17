import { createHash } from "crypto";
import { readFileSync } from "fs";
import type { StoredEmail } from "./db";
import { attempt, HttpError, parseJson, toError } from "./errors";
import { ORDER_STATUSES, type Extraction } from "./schema";

export const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
export const MODEL = process.env.OLLAMA_MODEL ?? "qwen3:8b";
const KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE ?? "1m";
const MAX_BODY_CHARS = 8000;
const MODEL_OPTIONS = { temperature: 0 };
const NOT_AN_ORDER = /"isOrderEmail"\s*:\s*false/;

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

const SYSTEM_PROMPT = `You extract online order and parcel delivery details from one email.
Set isOrderEmail to true only for a transactional email about one specific purchase or shipment of the recipient: an order confirmation, shipping or tracking notification, out-for-delivery, delivered, delay, cancellation or return notice.
Set isOrderEmail to false for everything else, including newsletters, promotions, review requests, account and security notices, bank, savings and investment messages, receipts for subscriptions or services, appointment confirmations, monitoring alerts and receipts for in-store purchases.
Only use information that is written in this email. Never guess, invent or use example values. Anything not in the email is null, and items is an empty list when no products are listed.
Copy orderNumber, trackingNumber and trackingUrl character for character from the email.
items lists every product in the order. name is the product name copied as written in the email, without article numbers or codes; if the email only shows codes, name is null. sku is the article or product code if shown. quantity is the number ordered, or null if not stated.
status meanings: ordered = order placed or confirmed, shipped = handed to carrier or tracking code sent, out_for_delivery = arriving today, delivered, delayed, cancelled, returned.
estimatedDelivery is the delivery date stated in the email as an ISO date (YYYY-MM-DD), otherwise null.`;

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

const PLACEHOLDER = /^(n\/?a|none|null|unknown|-|\?)$/i;
const MIN_REFERENCE_CHARS = 4;
const searchable = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

// The model sometimes invents order numbers and products, so only values that appear in the email are kept.
function groundExtraction(extraction: Extraction, email: StoredEmail): Extraction {
  const source = searchable([email.subject ?? "", email.text, htmlToText(email.html)].join(" "));
  const found = (value: string | null, minChars = 1) => {
    const key = value && !PLACEHOLDER.test(value.trim()) ? searchable(value) : "";
    return key.length >= minChars && source.includes(key) ? value : null;
  };
  return {
    ...extraction,
    orderNumber: found(extraction.orderNumber, MIN_REFERENCE_CHARS),
    trackingNumber: found(extraction.trackingNumber, MIN_REFERENCE_CHARS),
    trackingUrl: found(extraction.trackingUrl, MIN_REFERENCE_CHARS),
    items: extraction.items
      .map((item) => ({ ...item, name: found(item.name), sku: found(item.sku) }))
      .filter((item) => item.name || item.sku),
  };
}

// Any edit to this file can change the extraction, so its whole source is hashed and a change re-parses every stored email.
export const EXTRACTION_VERSION = createHash("sha256")
  .update(JSON.stringify([MODEL, readFileSync(import.meta.path, "utf8")]))
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
  const extraction = parseJson<Extraction>(content);
  if (extraction instanceof Error) return extraction;
  return groundExtraction(extraction, email);
}

export async function timedExtract(email: StoredEmail) {
  const started = performance.now();
  const result = await extract(email);
  if (result instanceof Error) return result;
  return { result, durationMs: Math.round(performance.now() - started) };
}
