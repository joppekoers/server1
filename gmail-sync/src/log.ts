import { format } from "util";
import { db } from "./db";
import { logs } from "./schema";

for (const level of ["log", "info", "warn", "error"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    original(...args);
    try {
      db.insert(logs).values({ at: new Date().toISOString(), level, message: format(...args) }).run();
    } catch (error) {
      original("Failed to write log to database:", error);
    }
  };
}

for (const event of ["uncaughtException", "unhandledRejection"] as const) {
  process.on(event, (error) => {
    console.error(`Fatal ${event}:`, error);
    process.exit(1);
  });
}
