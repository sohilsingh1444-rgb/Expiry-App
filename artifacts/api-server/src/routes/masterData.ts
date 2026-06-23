import { Router, type IRouter, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { gunzipSync, gzipSync } from "zlib";
import { db, appSettingsTable } from "@workspace/db";

const router: IRouter = Router();

function checkAdminPassword(req: Request, res: Response): boolean {
  const adminPassword = process.env.ADMIN_PASSWORD;
  const itPassword = process.env.IT_PASSWORD;
  const provided = req.headers["x-admin-password"] as string | undefined;
  const validAdmin = adminPassword && provided === adminPassword;
  const validIt = itPassword && provided === itPassword;
  if (!validAdmin && !validIt) {
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
  const uploadedAt = await getSetting("bm_uploaded_at");
  const count = await getSetting("bm_count");
  // Only send `map` — byItem is rebuilt client-side to halve payload size.
  // Use level 9 (max compression) to stay within Vercel's 4.5 MB response limit.
  const payload = JSON.stringify({
    map: mapJson ? JSON.parse(mapJson) : {},
    uploadedAt: uploadedAt ?? null,
    count: count ? Number(count) : 0,
  });
  const compressed = gzipSync(Buffer.from(payload), { level: 9 });
  res.setHeader("Content-Encoding", "gzip");
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Vary", "Accept-Encoding");
  res.send(compressed);
});

// Public (no-auth) barcode-master upload — accepts same compressed format as admin route
router.post("/barcode-master", async (req, res): Promise<void> => {
  const body = req.body as { compressed?: string; map?: Record<string, unknown>; count?: number };
  let map: Record<string, unknown>;
  let count: number | undefined;
  if (body.compressed) {
    try {
      const buf = Buffer.from(body.compressed, "base64");
      const parsed = JSON.parse(gunzipSync(buf).toString()) as { map: Record<string, unknown>; count?: number };
      map = parsed.map; count = parsed.count;
    } catch { res.status(400).json({ error: "Failed to decompress payload" }); return; }
  } else { map = body.map ?? {}; count = body.count; }
  if (!map || typeof map !== "object" || Object.keys(map).length === 0) { res.status(400).json({ error: "map is required" }); return; }
  const byItem: Record<string, unknown> = {};
  for (const entry of Object.values(map)) {
    const e = entry as { itemNumber?: string; rrp?: string };
    if (e.itemNumber) { const ex = byItem[e.itemNumber] as { rrp?: string } | undefined; if (!ex || (e.rrp && !ex.rrp)) byItem[e.itemNumber] = entry; }
  }
  const now = new Date().toISOString();
  const itemCount = count ?? Object.keys(map).length;
  await setSetting("bm_map_json", JSON.stringify(map));
  await setSetting("bm_by_item_json", JSON.stringify(byItem));
  await setSetting("bm_uploaded_at", now);
  await setSetting("bm_count", String(itemCount));
  res.json({ ok: true, uploadedAt: now, count: itemCount });
});

router.post("/admin/barcode-master", async (req, res): Promise<void> => {
  if (!checkAdminPassword(req, res)) return;
  const body = req.body as { compressed?: string; map?: Record<string, unknown>; count?: number };

  let map: Record<string, unknown>;
  let count: number | undefined;

  if (body.compressed) {
    try {
      const buf = Buffer.from(body.compressed, "base64");
      const parsed = JSON.parse(gunzipSync(buf).toString()) as { map: Record<string, unknown>; count?: number };
      map = parsed.map;
      count = parsed.count;
    } catch {
      res.status(400).json({ error: "Failed to decompress payload" });
      return;
    }
  } else {
    map = body.map ?? {};
    count = body.count;
  }

  if (!map || typeof map !== "object" || Object.keys(map).length === 0) {
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

// ── RRP Data ──────────────────────────────────────────────────────────────────

router.get("/rrp-data/meta", async (_req, res): Promise<void> => {
  const uploadedAt = await getSetting("rrp_uploaded_at");
  const count = await getSetting("rrp_count");
  res.json({ uploadedAt: uploadedAt ?? null, count: count ? Number(count) : 0 });
});

router.get("/rrp-data", async (_req, res): Promise<void> => {
  const byItemJson = await getSetting("rrp_by_item_json");
  const uploadedAt = await getSetting("rrp_uploaded_at");
  const count = await getSetting("rrp_count");
  const payload = JSON.stringify({
    byItem: byItemJson ? JSON.parse(byItemJson) : {},
    uploadedAt: uploadedAt ?? null,
    count: count ? Number(count) : 0,
  });
  const compressed = gzipSync(Buffer.from(payload), { level: 9 });
  res.setHeader("Content-Encoding", "gzip");
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Vary", "Accept-Encoding");
  res.send(compressed);
});

// Public (no-auth) route — RRP data is non-sensitive product pricing
router.post("/rrp-data", async (req, res): Promise<void> => {
  const { byItem, count } = req.body as { byItem?: Record<string, unknown>; count?: number };
  if (!byItem || Object.keys(byItem).length === 0) { res.status(400).json({ error: "byItem is required" }); return; }
  const now = new Date().toISOString();
  const itemCount = count ?? Object.keys(byItem).length;
  await setSetting("rrp_by_item_json", JSON.stringify(byItem));
  await setSetting("rrp_uploaded_at", now);
  await setSetting("rrp_count", String(itemCount));
  res.json({ ok: true, uploadedAt: now, count: itemCount });
});

router.post("/admin/rrp-data", async (req, res): Promise<void> => {
  if (!checkAdminPassword(req, res)) return;
  const { byItem, count } = req.body as { byItem?: Record<string, unknown>; count?: number };
  if (!byItem || Object.keys(byItem).length === 0) {
    res.status(400).json({ error: "byItem is required" });
    return;
  }
  const now = new Date().toISOString();
  const itemCount = count ?? Object.keys(byItem).length;
  await setSetting("rrp_by_item_json", JSON.stringify(byItem));
  await setSetting("rrp_uploaded_at", now);
  await setSetting("rrp_count", String(itemCount));
  res.json({ ok: true, uploadedAt: now, count: itemCount });
});

router.delete("/admin/rrp-data", async (req, res): Promise<void> => {
  if (!checkAdminPassword(req, res)) return;
  for (const key of ["rrp_by_item_json", "rrp_uploaded_at", "rrp_count"]) {
    await db.delete(appSettingsTable).where(eq(appSettingsTable.key, key));
  }
  res.json({ ok: true });
});

// ── Specials Data ─────────────────────────────────────────────────────────────

router.get("/specials-data/meta", async (_req, res): Promise<void> => {
  const uploadedAt = await getSetting("specials_uploaded_at");
  const count = await getSetting("specials_count");
  res.json({ uploadedAt: uploadedAt ?? null, count: count ? Number(count) : 0 });
});

router.get("/specials-data", async (_req, res): Promise<void> => {
  const byItemJson = await getSetting("specials_by_item_json");
  const uploadedAt = await getSetting("specials_uploaded_at");
  const count = await getSetting("specials_count");
  const payload = JSON.stringify({
    byItem: byItemJson ? JSON.parse(byItemJson) : {},
    uploadedAt: uploadedAt ?? null,
    count: count ? Number(count) : 0,
  });
  const compressed = gzipSync(Buffer.from(payload), { level: 9 });
  res.setHeader("Content-Encoding", "gzip");
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Vary", "Accept-Encoding");
  res.send(compressed);
});

// Public (no-auth) route — Specials data is non-sensitive product pricing
router.post("/specials-data", async (req, res): Promise<void> => {
  const { byItem, count } = req.body as { byItem?: Record<string, unknown>; count?: number };
  if (!byItem || Object.keys(byItem).length === 0) { res.status(400).json({ error: "byItem is required" }); return; }
  const now = new Date().toISOString();
  const itemCount = count ?? Object.keys(byItem).length;
  await setSetting("specials_by_item_json", JSON.stringify(byItem));
  await setSetting("specials_uploaded_at", now);
  await setSetting("specials_count", String(itemCount));
  res.json({ ok: true, uploadedAt: now, count: itemCount });
});

router.post("/admin/specials-data", async (req, res): Promise<void> => {
  if (!checkAdminPassword(req, res)) return;
  const { byItem, count } = req.body as { byItem?: Record<string, unknown>; count?: number };
  if (!byItem || Object.keys(byItem).length === 0) {
    res.status(400).json({ error: "byItem is required" });
    return;
  }
  const now = new Date().toISOString();
  const itemCount = count ?? Object.keys(byItem).length;
  await setSetting("specials_by_item_json", JSON.stringify(byItem));
  await setSetting("specials_uploaded_at", now);
  await setSetting("specials_count", String(itemCount));
  res.json({ ok: true, uploadedAt: now, count: itemCount });
});

router.delete("/admin/specials-data", async (req, res): Promise<void> => {
  if (!checkAdminPassword(req, res)) return;
  for (const key of ["specials_by_item_json", "specials_uploaded_at", "specials_count"]) {
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
  const byStoreJson = await getSetting("soh_by_store_json");
  const byRegionJson = await getSetting("soh_by_region_json");
  const uploadedAt = await getSetting("soh_uploaded_at");
  const count = await getSetting("soh_count");
  const payload = JSON.stringify({
    byBarcode: byBarcodeJson ? JSON.parse(byBarcodeJson) : {},
    byItem: byItemJson ? JSON.parse(byItemJson) : {},
    byStore: byStoreJson ? JSON.parse(byStoreJson) : {},
    byRegion: byRegionJson ? JSON.parse(byRegionJson) : {},
    uploadedAt: uploadedAt ?? null,
    count: count ? Number(count) : 0,
  });
  const compressed = gzipSync(Buffer.from(payload), { level: 9 });
  res.setHeader("Content-Encoding", "gzip");
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Vary", "Accept-Encoding");
  res.send(compressed);
});

router.post("/admin/soh-data", async (req, res): Promise<void> => {
  if (!checkAdminPassword(req, res)) return;
  const { byBarcode, byItem, byStore, byRegion, count } = req.body as {
    byBarcode?: Record<string, number>;
    byItem?: Record<string, number>;
    byStore?: Record<string, unknown>;
    byRegion?: Record<string, unknown>;
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
  await setSetting("soh_by_store_json", JSON.stringify(byStore ?? {}));
  await setSetting("soh_by_region_json", JSON.stringify(byRegion ?? {}));
  await setSetting("soh_uploaded_at", now);
  await setSetting("soh_count", String(itemCount));
  res.json({ ok: true, uploadedAt: now, count: itemCount });
});

router.delete("/admin/soh-data", async (req, res): Promise<void> => {
  if (!checkAdminPassword(req, res)) return;
  for (const key of ["soh_by_barcode_json", "soh_by_item_json", "soh_by_store_json", "soh_by_region_json", "soh_uploaded_at", "soh_count"]) {
    await db.delete(appSettingsTable).where(eq(appSettingsTable.key, key));
  }
  res.json({ ok: true });
});

export default router;
