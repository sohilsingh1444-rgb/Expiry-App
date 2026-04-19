import { createInsertSchema } from "drizzle-zod";
import { date, doublePrecision, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const expiryScansTable = pgTable("expiry_scans", {
  id: serial("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  pdUserName: text("pd_user_name").notNull(),
  storeLocation: text("store_location").notNull(),
  barcode: text("barcode").notNull(),
  itemNumber: text("item_number"),
  description: text("description"),
  qty: doublePrecision("qty").notNull(),
  expiryDate: date("expiry_date").notNull(),
  status: text("status").notNull(),
  daysLeft: integer("days_left").notNull(),
  scanDate: date("scan_date").notNull(),
  actionRequired: text("action_required"),
  remarks: text("remarks"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertExpiryScanSchema = createInsertSchema(expiryScansTable).omit({
  id: true,
  createdAt: true,
});

export type InsertExpiryScan = z.infer<typeof insertExpiryScanSchema>;
export type ExpiryScan = typeof expiryScansTable.$inferSelect;
