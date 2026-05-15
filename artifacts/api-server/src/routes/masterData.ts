import { Router, type IRouter, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { db, appSettingsTable } from "@workspace/db";

const router: IRouter = Router();

function checkAdminPassword(req: Request, res: Response): boolean {
  const adminPassword = process.env.ADMIN_PASSWORD;
  const provided = req.headers["x-admin-password"] as string | undefined;
  if (!adminPassword || provided !== adminPassword) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

async function setSetting(key: string, value: string): Promise<void> {
  await db
    .insert(appSettingsTable)
    .values({ key, value })
    .onConflictDoUpdate({ target: appSettingsTable.key, set: { value, updatedAt: new Date() } });
}

async function getSetting(key: string): Promise<string | null> {
  const [row] = await db.select().from(appSettingsTable).where(eq(appSettingsTable.key, key));
  return row?.value ?? null;
}

// ── Barcode Master ────────────────────────────────────────────────────────────

router.get("/barcode-master/meta", async (_req, res): Promise<void> => {
  const uploadedAt = await getSetting("bm_uploaded_at");
  const count = await getSetting("bm_count");
  res.json({ uploadedAt: uploadedAt ?? null, count: count ? Number(count) : 0 });
});

router.get("/barcode-master", async (_req, res): Promise<void> => {
  const mapJson = await getSetting("bm_map_json");
  const byItemJson = await getSetting("bm_by_item_json");
  const uploadedAt = await getSetting("bm_uploaded_at");
  const count = await getSetting("bm_count");
  res.json({
    map: mapJson ? JSON.parse(mapJson) : {},
    byItem: byItemJson ? JSON.parse(byItemJson) : {},
    uploadedAt: uploadedAt ?? null,
    count: count ? Number(count) : 0,
  });
});

router.post("/admin/barcode-master", async (req, res): Promise<void> => {
  if (!checkAdminPassword(req, res)) return;
  const { map, count } = req.body as {
    map?: Record<string, unknown>;
    count?: number;
  };
  if (!map || typeof map !== "object") {
    res.status(400).json({ error: "map is required" });
    return;
  }
  // Build byItem server-side: one entry per itemNumber, preferring entries with RRP
  const byItem: Record<string, unknown> = {};
  for (const entry of Object.values(map)) {
    const e = entry as { itemNumber?: string; rrp?: string };
    if (e.itemNumber) {
      const existing = byItem[e.itemNumber] as { rrp?: string } | undefined;
      if (!existing || (e.rrp && !existing.rrp)) {
        byItem[e.itemNumber] = entry;
      }
    }
  }
  const now = new Date().toISOString();
  const itemCount = count ?? Object.keys(map).length;
  await setSetting("bm_map_json", JSON.stringify(map));
  await setSetting("bm_by_item_json", JSON.stringify(byItem));
  await setSetting("bm_uploaded_at", now);
  await setSetting("bm_count", String(itemCount));
  res.json({ ok: true, uploadedAt: now, count: itemCount });
});

router.delete("/admin/barcode-master", async (req, res): Promise<void> => {
  if (!checkAdminPassword(req, res)) return;
  for (const key of ["bm_map_json", "bm_by_item_json", "bm_uploaded_at", "bm_count"]) {
    await db.delete(appSettingsTable).where(eq(appSettingsTable.key, key));
  }
  res.json({ ok: true });
});

// ── SOH Data ──────────────────────────────────────────────────────────────────

router.get("/soh-data/meta", async (_req, res): Promise<void> => {
  const uploadedAt = await getSetting("soh_uploaded_at");
  const count = await getSetting("soh_count");
  res.json({ uploadedAt: uploadedAt ?? null, count: count ? Number(count) : 0 });
});

router.get("/soh-data", async (_req, res): Promise<void> => {
  const byBarcodeJson = await getSetting("soh_by_barcode_json");
  const byItemJson = await getSetting("soh_by_item_json");
  const uploadedAt = await getSetting("soh_uploaded_at");
  const count = await getSetting("soh_count");
  res.json({
    byBarcode: byBarcodeJson ? JSON.parse(byBarcodeJson) : {},
    byItem: byItemJson ? JSON.parse(byItemJson) : {},
    uploadedAt: uploadedAt ?? null,
    count: count ? Number(count) : 0,
  });
});

router.post("/admin/soh-data", async (req, res): Promise<void> => {
  if (!checkAdminPassword(req, res)) return;
  const { byBarcode, byItem, count } = req.body as {
    byBarcode?: Record<string, number>;
    byItem?: Record<string, number>;
    count?: number;
  };
  if (!byBarcode && !byItem) {
    res.status(400).json({ error: "byBarcode or byItem is required" });
    return;
  }
  const now = new Date().toISOString();
  const itemCount = count ?? Math.max(
    Object.keys(byBarcode ?? {}).length,
    Object.keys(byItem ?? {}).length,
  );
  await setSetting("soh_by_barcode_json", JSON.stringify(byBarcode ?? {}));
  await setSetting("soh_by_item_json", JSON.stringify(byItem ?? {}));
  await setSetting("soh_uploaded_at", now);
  await setSetting("soh_count", String(itemCount));
  res.json({ ok: true, uploadedAt: now, count: itemCount });
});

router.delete("/admin/soh-data", async (req, res): Promise<void> => {
  if (!checkAdminPassword(req, res)) return;
  for (const key of ["soh_by_barcode_json", "soh_by_item_json", "soh_uploaded_at", "soh_count"]) {
    await db.delete(appSettingsTable).where(eq(appSettingsTable.key, key));
  }
  res.json({ ok: true });
});

export default router;
