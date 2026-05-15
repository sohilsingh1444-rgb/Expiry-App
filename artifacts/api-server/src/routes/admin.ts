import { Router, type IRouter, type Request, type Response } from "express";
import { eq, sql } from "drizzle-orm";
import { db, expiryScansTable, appSettingsTable, storesTable } from "@workspace/db";

const router: IRouter = Router();

const DEFAULT_URGENT_DAYS = 2;
const DEFAULT_NEAR_EXPIRY_DAYS = 15;

const DEFAULT_STORES: Array<{ code: string; name: string; region: string; emails: string[] }> = [
  { code: "S0001", name: "Newworld Ba1",         region: "WR", emails: [] },
  { code: "S0003", name: "Newworld Ba3",          region: "WR", emails: [] },
  { code: "S0005", name: "Newworld Adams",        region: "WR", emails: [] },
  { code: "S0006", name: "Newworld Namaka",       region: "WR", emails: [] },
  { code: "S0010", name: "Newworld Nadi Town",    region: "WR", emails: [] },
  { code: "S0011", name: "IGA Super",             region: "WR", emails: [] },
  { code: "S0013", name: "Newworld Rakiraki",     region: "WR", emails: [] },
  { code: "S0025", name: "Newworld Tavua",        region: "WR", emails: [] },
  { code: "S0018", name: "IGA Lautoka",           region: "WR", emails: [] },
  { code: "S0035", name: "IGA Waiyavi",           region: "WR", emails: [] },
  { code: "S0036", name: "IGA Nadi Plaza",        region: "WR", emails: [] },
  { code: "B0004", name: "Lautoka Warehouse",     region: "WR", emails: [] },
  { code: "B0008", name: "Nwl CDC",               region: "WR", emails: [] },
  { code: "B0002", name: "Ghimly Warehouse",      region: "WR", emails: [] },
  { code: "B0001", name: "Ba Warehouse",          region: "WR", emails: [] },
  { code: "S0019", name: "IGA Nakasi",            region: "CR", emails: [] },
  { code: "S0020", name: "Newworld Narere",       region: "CR", emails: [] },
  { code: "S0026", name: "Newworld VitiPlaza",    region: "CR", emails: [] },
  { code: "S0021", name: "Newworld Nausori",      region: "CR", emails: [] },
  { code: "S0029", name: "IGA Damodar",           region: "CR", emails: [] },
  { code: "S0033", name: "IGA Greig St",          region: "CR", emails: [] },
  { code: "S0032", name: "Central Bakery",        region: "CR", emails: [] },
  { code: "B0003", name: "Vatuwaqa Warehouse",    region: "CR", emails: [] },
  { code: "S0014", name: "Newworld Labasa",       region: "NR", emails: [] },
  { code: "S0016", name: "IGA Savusavu",          region: "NR", emails: [] },
];

export async function ensureStoresSeeded() {
  const count = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(storesTable);
  if ((count[0]?.count ?? 0) === 0) {
    await db.insert(storesTable).values(DEFAULT_STORES).onConflictDoNothing();
  }
}

function checkAdminPassword(req: Request, res: Response): boolean {
  const adminPassword = process.env.ADMIN_PASSWORD;
  const provided = req.headers["x-admin-password"] as string | undefined;
  if (!adminPassword || provided !== adminPassword) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

async function getSetting(key: string, defaultValue: string): Promise<string> {
  const [row] = await db
    .select()
    .from(appSettingsTable)
    .where(eq(appSettingsTable.key, key));
  return row?.value ?? defaultValue;
}

router.post("/admin/verify", (req, res): void => {
  const adminPassword = process.env.ADMIN_PASSWORD;
  const { password } = req.body as { password?: string };
  if (!adminPassword || password !== adminPassword) {
    res.status(401).json({ error: "Invalid password" });
    return;
  }
  res.json({ ok: true });
});

router.post("/admin/it-verify", (req, res): void => {
  const itPassword = process.env.IT_PASSWORD;
  const { password } = req.body as { password?: string };
  if (!itPassword || password !== itPassword) {
    res.status(401).json({ error: "Invalid password" });
    return;
  }
  res.json({ ok: true });
});

router.get("/admin/settings", async (_req, res): Promise<void> => {
  const urgentDays = await getSetting("urgent_days", String(DEFAULT_URGENT_DAYS));
  const nearExpiryDays = await getSetting("near_expiry_days", String(DEFAULT_NEAR_EXPIRY_DAYS));
  res.json({
    urgentDays: Number(urgentDays),
    nearExpiryDays: Number(nearExpiryDays),
  });
});

router.put("/admin/settings", async (req, res): Promise<void> => {
  if (!checkAdminPassword(req, res)) return;

  const { urgentDays, nearExpiryDays } = req.body as { urgentDays?: number; nearExpiryDays?: number };

  if (
    typeof urgentDays !== "number" ||
    typeof nearExpiryDays !== "number" ||
    urgentDays < 0 ||
    nearExpiryDays <= urgentDays
  ) {
    res.status(400).json({ error: "Invalid thresholds. Near Expiry must be greater than Urgent." });
    return;
  }

  await db
    .insert(appSettingsTable)
    .values({ key: "urgent_days", value: String(urgentDays) })
    .onConflictDoUpdate({ target: appSettingsTable.key, set: { value: String(urgentDays), updatedAt: new Date() } });

  await db
    .insert(appSettingsTable)
    .values({ key: "near_expiry_days", value: String(nearExpiryDays) })
    .onConflictDoUpdate({ target: appSettingsTable.key, set: { value: String(nearExpiryDays), updatedAt: new Date() } });

  res.json({ urgentDays, nearExpiryDays });
});

router.get("/admin/sessions", async (req, res): Promise<void> => {
  if (!checkAdminPassword(req, res)) return;

  const rows = await db
    .select({
      sessionId: expiryScansTable.sessionId,
      pdUserName: expiryScansTable.pdUserName,
      storeLocation: expiryScansTable.storeLocation,
      scanDate: expiryScansTable.scanDate,
      scanCount: sql<number>`count(*)::int`,
      createdAt: sql<string>`min(${expiryScansTable.createdAt})`,
    })
    .from(expiryScansTable)
    .groupBy(
      expiryScansTable.sessionId,
      expiryScansTable.pdUserName,
      expiryScansTable.storeLocation,
      expiryScansTable.scanDate,
    )
    .orderBy(sql`min(${expiryScansTable.createdAt}) desc`);

  res.json(rows);
});

router.delete("/admin/sessions/:sessionId", async (req, res): Promise<void> => {
  if (!checkAdminPassword(req, res)) return;

  const { sessionId } = req.params;
  if (!sessionId) {
    res.status(400).json({ error: "sessionId is required" });
    return;
  }

  const deleted = await db
    .delete(expiryScansTable)
    .where(eq(expiryScansTable.sessionId, sessionId))
    .returning({ id: expiryScansTable.id });

  res.json({ deleted: deleted.length });
});

// ── Public: store list (used by main app combobox) ───────────────────────────

router.get("/stores", async (_req, res): Promise<void> => {
  await ensureStoresSeeded();
  const stores = await db
    .select({ code: storesTable.code, name: storesTable.name, region: storesTable.region })
    .from(storesTable)
    .orderBy(storesTable.region, storesTable.code);
  res.json(stores);
});

// ── Stores CRUD (admin-only) ─────────────────────────────────────────────────

router.get("/admin/stores", async (req, res): Promise<void> => {
  if (!checkAdminPassword(req, res)) return;
  await ensureStoresSeeded();
  const stores = await db.select().from(storesTable).orderBy(storesTable.region, storesTable.code);
  res.json(stores);
});

router.post("/admin/stores", async (req, res): Promise<void> => {
  if (!checkAdminPassword(req, res)) return;

  const { code, name, region, emails } = req.body as {
    code?: string;
    name?: string;
    region?: string;
    emails?: string[];
  };

  if (!code || !name) {
    res.status(400).json({ error: "code and name are required" });
    return;
  }
  if (!Array.isArray(emails)) {
    res.status(400).json({ error: "emails must be an array" });
    return;
  }
  const regionVal = (["WR", "CR", "NR"].includes(region ?? "") ? region : "WR") as string;

  let row;
  try {
    [row] = await db
      .insert(storesTable)
      .values({ code: code.toUpperCase().trim(), name: name.trim(), region: regionVal, emails })
      .returning();
  } catch (err: unknown) {
    const msg = `${err instanceof Error ? err.message : ""} ${String(err)}`;
    const causeMsg = err instanceof Error && err.cause instanceof Error ? err.cause.message : "";
    const fullMsg = msg + " " + causeMsg;
    if (fullMsg.includes("duplicate key") || fullMsg.includes("unique constraint")) {
      res.status(409).json({ error: `Store code "${code.toUpperCase().trim()}" already exists. Use Edit to update it.` });
      return;
    }
    const detail = err instanceof Error && err.cause instanceof Error ? err.cause.message : String(err);
    res.status(500).json({ error: "Database error", detail });
  }

  res.status(201).json(row);
});

router.put("/admin/stores/:code", async (req, res): Promise<void> => {
  if (!checkAdminPassword(req, res)) return;

  const { code } = req.params;
  const { name, region, emails } = req.body as {
    name?: string;
    region?: string;
    emails?: string[];
  };

  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  if (!Array.isArray(emails)) {
    res.status(400).json({ error: "emails must be an array" });
    return;
  }
  const regionVal = (["WR", "CR", "NR"].includes(region ?? "") ? region : "WR") as string;

  const [row] = await db
    .update(storesTable)
    .set({ name: name.trim(), region: regionVal, emails, updatedAt: new Date() })
    .where(eq(storesTable.code, code.toUpperCase()))
    .returning();

  if (!row) {
    res.status(404).json({ error: "Store not found" });
    return;
  }

  res.json(row);
});

router.delete("/admin/stores/:code", async (req, res): Promise<void> => {
  if (!checkAdminPassword(req, res)) return;

  const { code } = req.params;

  const deleted = await db
    .delete(storesTable)
    .where(eq(storesTable.code, code.toUpperCase()))
    .returning({ code: storesTable.code });

  if (!deleted.length) {
    res.status(404).json({ error: "Store not found" });
    return;
  }

  res.json({ deleted: deleted.length });
});

export default router;
