import { createInsertSchema } from "drizzle-zod";
import { boolean, date, doublePrecision, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const storesTable = pgTable("stores", {
  code: text("code").primaryKey(),
  name: text("name").notNull(),
  region: text("region").notNull().default("WR"),
  emails: text("emails").array().notNull().default([]),
  sohLocationCodes: text("soh_location_codes").array().notNull().default([]),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const appSettingsTable = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const expiryScansTable = pgTable("expiry_scans", {
  id: serial("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  pdUserName: text("pd_user_name").notNull(),
  storeLocation: text("store_location").notNull(),
  barcode: text("barcode").notNull(),
  itemNumber: text("item_number"),
  description: text("description"),
  qty: doublePrecision("qty").notNull(),
  rrp: doublePrecision("rrp"),
  specialPrice: doublePrecision("special_price"),
  systemSoh: doublePrecision("system_soh"),
  wrongRrp: boolean("wrong_rrp").notNull().default(false),
  missingSpecialTicket: boolean("missing_special_ticket").notNull().default(false),
  notOnDisplay: boolean("not_on_display").notNull().default(false),
  bulkPullQty: doublePrecision("bulk_pull_qty"),
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
