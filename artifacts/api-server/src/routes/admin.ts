import { Router, type IRouter, type Request, type Response } from "express";
import { eq, sql } from "drizzle-orm";
import { db, expiryScansTable, appSettingsTable, storesTable } from "@workspace/db";

const router: IRouter = Router();

const DEFAULT_URGENT_DAYS = 2;
const DEFAULT_NEAR_EXPIRY_DAYS = 15;

const DEFAULT_STORES: Array<{ code: string; name: string; emails: string[] }> = [
  { code: "S0001", name: "New World Laucala Bay (S0001)", emails: ["nwlba1@newworld.com.fj", "mgr_ba1@newworld.com.fj"] },
  { code: "S0003", name: "New World Laucala Bay 3 (S0003)", emails: ["nwlba3@newworld.com.fj"] },
  { code: "S0005", name: "New World Lami (S0005)", emails: ["nwlada@newworld.com.fj"] },
  { code: "S0006", name: "New World Nadi (S0006)", emails: ["nwlnad@newworld.com.fj"] },
  { code: "S0010", name: "New World Nausori (S0010)", emails: ["nwlnts@newworld.com.fj"] },
  { code: "S0011", name: "IGA Superstore (S0011)", emails: ["igasup@newworld.com.fj"] },
  { code: "S0013", name: "New World Rakiraki (S0013)", emails: ["nwlrak@newworld.com.fj"] },
  { code: "S0014", name: "New World Labasa (S0014)", emails: ["nwllab@newworld.com.fj"] },
  { code: "S0016", name: "IGA Savusavu (S0016)", emails: ["igasavusavu@newworld.com.fj"] },
  { code: "S0018", name: "IGA Lautoka (S0018)", emails: ["igaltk@newworld.com.fj"] },
  { code: "S0019", name: "IGA Nakasi (S0019)", emails: ["iganak@newworld.com.fj"] },
  { code: "S0020", name: "New World Narere (S0020)", emails: ["nwlnar@newworld.com.fj"] },
  { code: "S0021", name: "New World Nausori (S0021)", emails: ["nwlnau@newworld.com.fj"] },
  { code: "S0025", name: "New World Tavua (S0025)", emails: ["nwltav@newworld.com.fj"] },
  { code: "S0026", name: "New World Valelevu (S0026)", emails: ["nwlvit@newworld.com.fj"] },
  { code: "S0029", name: "IGA Downtown (S0029)", emails: ["igadcc@newworld.com.fj"] },
  { code: "S0033", name: "IGA GST (S0033)", emails: ["igagst@newworld.com.fj"] },
  { code: "S0035", name: "IGA Waiyavi (S0035)", emails: ["igawaiyavi@newworld.com.fj"] },
  { code: "S0036", name: "IGA Nadi (S0036)", emails: ["iganad@newworld.com.fj"] },
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

// ── Stores CRUD ──────────────────────────────────────────────────────────────

router.get("/admin/stores", async (req, res): Promise<void> => {
  if (!checkAdminPassword(req, res)) return;
  await ensureStoresSeeded();
  const stores = await db.select().from(storesTable).orderBy(storesTable.code);
  res.json(stores);
});

router.post("/admin/stores", async (req, res): Promise<void> => {
  if (!checkAdminPassword(req, res)) return;

  const { code, name, emails } = req.body as { code?: string; name?: string; emails?: string[] };

  if (!code || !name) {
    res.status(400).json({ error: "code and name are required" });
    return;
  }
  if (!Array.isArray(emails)) {
    res.status(400).json({ error: "emails must be an array" });
    return;
  }

  const [row] = await db
    .insert(storesTable)
    .values({ code: code.toUpperCase().trim(), name: name.trim(), emails })
    .returning();

  res.status(201).json(row);
});

router.put("/admin/stores/:code", async (req, res): Promise<void> => {
  if (!checkAdminPassword(req, res)) return;

  const { code } = req.params;
  const { name, emails } = req.body as { name?: string; emails?: string[] };

  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  if (!Array.isArray(emails)) {
    res.status(400).json({ error: "emails must be an array" });
    return;
  }

  const [row] = await db
    .update(storesTable)
    .set({ name: name.trim(), emails, updatedAt: new Date() })
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
