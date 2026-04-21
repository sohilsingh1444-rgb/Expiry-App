import { Router, type IRouter, type Request, type Response } from "express";
import { eq, sql } from "drizzle-orm";
import { db, expiryScansTable, appSettingsTable } from "@workspace/db";

const router: IRouter = Router();

const DEFAULT_URGENT_DAYS = 2;
const DEFAULT_NEAR_EXPIRY_DAYS = 15;

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

export default router;
