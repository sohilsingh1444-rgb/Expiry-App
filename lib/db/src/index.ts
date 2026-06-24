import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool, types } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set. Did you forget to provision a database?");
}

// Supabase uses PgBouncer (transaction pooler) which skips type OID negotiation,
// causing the pg driver to return all values as strings. Set explicit parsers.
types.setTypeParser(types.builtins.INT2, (v) => parseInt(v, 10));
types.setTypeParser(types.builtins.INT4, (v) => parseInt(v, 10));
types.setTypeParser(types.builtins.INT8, (v) => parseInt(v, 10));
types.setTypeParser(types.builtins.FLOAT4, (v) => parseFloat(v));
types.setTypeParser(types.builtins.FLOAT8, (v) => parseFloat(v));
types.setTypeParser(types.builtins.NUMERIC, (v) => parseFloat(v));
types.setTypeParser(types.builtins.BOOL, (v) => v === "t" || v === "true");

const ssl = process.env.DATABASE_URL.includes("neon.tech") ||
  process.env.DATABASE_URL.includes("supabase.com") ||
  process.env.DATABASE_URL.includes("sslmode=require")
  ? { rejectUnauthorized: false }
  : undefined;

export const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl });
export const db = drizzle(pool, { schema });

export * from "./schema";
