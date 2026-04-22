import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

function getConnectionConfig(): { connectionString: string; ssl?: { rejectUnauthorized: boolean } } {
  const isDev = process.env.NODE_ENV === "development";

  // In development, always use the local DATABASE_URL — never Supabase
  if (!isDev) {
    const supabasePw = process.env.SUPABASE_DATABASE_URL;
    if (supabasePw && !supabasePw.startsWith("postgresql://")) {
      return {
        connectionString: `postgresql://postgres.ilawvbdiapajzvjvawds:${encodeURIComponent(supabasePw)}@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres`,
        ssl: { rejectUnauthorized: false },
      };
    }
    if (supabasePw && supabasePw.startsWith("postgresql://")) {
      return {
        connectionString: supabasePw,
        ssl: { rejectUnauthorized: false },
      };
    }
  }

  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be set. Did you forget to provision a database?");
  }
  return { connectionString: process.env.DATABASE_URL };
}

const config = getConnectionConfig();

export const pool = new Pool(config);
export const db = drizzle(pool, { schema });

export * from "./schema";
