import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

function getConnectionString(): string {
  const supabasePw = process.env.SUPABASE_DATABASE_URL;
  if (supabasePw && !supabasePw.startsWith("postgresql://")) {
    return `postgresql://postgres.ilawvbdiapajzvjvawds:${encodeURIComponent(supabasePw)}@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres`;
  }
  if (supabasePw && supabasePw.startsWith("postgresql://")) {
    return supabasePw;
  }
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be set. Did you forget to provision a database?");
  }
  return process.env.DATABASE_URL;
}

const connectionString = getConnectionString();

export const pool = new Pool({ connectionString });
export const db = drizzle(pool, { schema });

export * from "./schema";
