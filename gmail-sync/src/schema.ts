import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const ORDER_STATUSES = ["ordered", "shipped", "out_for_delivery", "delivered", "delayed", "cancelled", "returned"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export interface OrderItem {
  name: string | null;
  sku: string | null;
  quantity: number | null;
}

export interface Extraction {
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

export const kv = sqliteTable("kv", {
  key: text().primaryKey(),
  value: text().notNull(),
});

export const emails = sqliteTable("emails", {
  id: text().primaryKey(),
  threadId: text("thread_id").notNull(),
  receivedAt: text("received_at").notNull(),
  fromAddress: text("from_address"),
  toAddress: text("to_address"),
  cc: text(),
  subject: text(),
  snippet: text(),
  text: text().notNull(),
  html: text().notNull(),
  labelIds: text("label_ids", { mode: "json" }).$type<string[]>().notNull(),
  attachments: text({ mode: "json" }).$type<string[]>().notNull(),
  headers: text({ mode: "json" }).$type<{ name: string; value: string }[]>().notNull(),
});

export const emailExtractions = sqliteTable("email_extractions", {
  emailId: text("email_id")
    .primaryKey()
    .references(() => emails.id),
  version: text().notNull(),
  result: text({ mode: "json" }).$type<Extraction | null>(),
  extractedAt: text("extracted_at").notNull(),
});

export const orders = sqliteTable(
  "orders",
  {
    id: integer().primaryKey(),
    merchant: text(),
    orderNumber: text("order_number"),
    orderNumberKey: text("order_number_key"),
    status: text({ enum: ORDER_STATUSES }),
    items: text({ mode: "json" }).$type<OrderItem[]>().notNull(),
    carrier: text(),
    trackingNumber: text("tracking_number"),
    trackingNumberKey: text("tracking_number_key"),
    trackingUrl: text("tracking_url"),
    estimatedDelivery: text("estimated_delivery"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("orders_order_number_key").on(table.orderNumberKey),
    index("orders_tracking_number_key").on(table.trackingNumberKey),
  ],
);

export const orderEvents = sqliteTable(
  "order_events",
  {
    orderId: integer("order_id").notNull().references(() => orders.id),
    emailId: text("email_id").notNull(),
    status: text({ enum: ORDER_STATUSES }),
    at: text().notNull(),
    subject: text(),
  },
  (table) => [primaryKey({ columns: [table.orderId, table.emailId] })],
);

export const logs = sqliteTable(
  "logs",
  {
    id: integer().primaryKey(),
    at: text().notNull(),
    level: text({ enum: ["log", "info", "warn", "error"] }).notNull(),
    message: text().notNull(),
  },
  (table) => [index("logs_at").on(table.at)],
);
