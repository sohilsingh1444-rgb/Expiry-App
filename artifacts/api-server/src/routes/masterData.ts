import { Router, type IRouter, type Request, type Response } from "express";
import { eq, inArray } from "drizzle-orm";
import { gunzipSync, gzipSync } from "zlib";
import { db, appSettingsTable } from "@workspace/db";

const router: IRouter = Router();

// ── In-memory response cache (survives across requests on warm instances) ─────
// Key: cache name (e.g. "bm", "rrp", "specials", "soh")
// Value: pre-compressed gzip Buffer ready to send
const memCache = new Map<string, Buffer>();

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

async function getSettings(keys: string[]): Promise<Map<string, string>> {
  const rows = await db.select().from(appSettingsTable).where(inArray(appSettingsTable.key, keys));
  return new Map(rows.map((r) => [r.key, r.value]));
}

/** Compress JSON payload and store in DB + memory cache. Level 6 = good ratio, fast. */
async function storeCompressed(cacheKey: string, payload: string): Promise<Buffer> {
  const buf = gzipSync(Buffer.from(payload), { level: 6 });
  memCache.set(cacheKey, buf);
  await setSetting(`${cacheKey}_gz`, buf.toString("base64"));
  return buf;
}

/** Send pre-compressed gzip buffer as JSON response. */
function sendCompressed(res: Response, buf: Buffer): void {
  res.setHeader("Content-Encoding", "gzip");
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Vary", "Accept-Encoding");
  res.setHeader("Cache-Control", "no-store");
  res.send(buf);
}

// ── Barcode Master ────────────────────────────────────────────────────────────

router.get("/barcode-master/meta", async (_req, res): Promise<void> => {
  const settings = await getSettings(["bm_uploaded_at", "bm_count"]);
  res.setHeader("Cache-Control", "no-store");
  res.json({ uploadedAt: settings.get("bm_uploaded_at") ?? null, count: Number(settings.get("bm_count") ?? 0) });
});

router.get("/barcode-master", async (_req, res): Promise<void> => {
  // 1. Warm memory cache
  const cached = memCache.get("bm");
  if (cached) { sendCompressed(res, cached); return; }

  // 2. Pre-compressed DB cache
  const gz = await getSetting("bm_gz");
  if (gz) {
    const buf = Buffer.from(gz, "base64");
    memCache.set("bm", buf);
    sendCompressed(res, buf);
    return;
  }

  // 3. Fall back: build from raw data and populate both caches for next time
  const settings = await getSettings(["bm_map_json", "bm_uploaded_at", "bm_count"]);
  const mapJson = settings.get("bm_map_json");
  const payload = JSON.stringify({
    map: mapJson ? JSON.parse(mapJson) : {},
    uploadedAt: settings.get("bm_uploaded_at") ?? null,
    count: Number(settings.get("bm_count") ?? 0),
  });
  const buf = await storeCompressed("bm", payload);
  sendCompressed(res, buf);
});

async function saveBarcodemaster(
  map: Record<string, unknown>,
  count: number,
  now: string,
): Promise<void> {
  const byItem: Record<string, unknown> = {};
  for (const entry of Object.values(map)) {
    const e = entry as { itemNumber?: string; rrp?: string };
    if (e.itemNumber) {
      const existing = byItem[e.itemNumber] as { rrp?: string } | undefined;
      if (!existing || (e.rrp && !existing.rrp)) byItem[e.itemNumber] = entry;
    }
  }
  const mapStr = JSON.stringify(map);
  const payload = JSON.stringify({ map, uploadedAt: now, count });
  await Promise.all([
    setSetting("bm_map_json", mapStr),
    setSetting("bm_by_item_json", JSON.stringify(byItem)),
    setSetting("bm_uploaded_at", now),
    setSetting("bm_count", String(count)),
    storeCompressed("bm", payload),
  ]);
}

// Public (no-auth) barcode-master upload
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
  const now = new Date().toISOString();
  const itemCount = count ?? Object.keys(map).length;
  try {
    await saveBarcodemaster(map, itemCount, now);
  } catch { res.status(500).json({ error: "Failed to save barcode master data. Please try again." }); return; }
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
      map = parsed.map; count = parsed.count;
    } catch { res.status(400).json({ error: "Failed to decompress payload" }); return; }
  } else { map = body.map ?? {}; count = body.count; }
  if (!map || typeof map !== "object" || Object.keys(map).length === 0) { res.status(400).json({ error: "map is required" }); return; }
  const now = new Date().toISOString();
  const itemCount = count ?? Object.keys(map).length;
  try {
    await saveBarcodemaster(map, itemCount, now);
  } catch { res.status(500).json({ error: "Failed to save barcode master data. Please try again." }); return; }
  res.json({ ok: true, uploadedAt: now, count: itemCount });
});

router.delete("/admin/barcode-master", async (req, res): Promise<void> => {
  if (!checkAdminPassword(req, res)) return;
  memCache.delete("bm");
  for (const key of ["bm_map_json", "bm_by_item_json", "bm_uploaded_at", "bm_count", "bm_gz"]) {
    await db.delete(appSettingsTable).where(eq(appSettingsTable.key, key));
  }
  res.json({ ok: true });
});

// ── RRP Data ──────────────────────────────────────────────────────────────────

router.get("/rrp-data/meta", async (_req, res): Promise<void> => {
  const settings = await getSettings(["rrp_uploaded_at", "rrp_count"]);
  res.setHeader("Cache-Control", "no-store");
  res.json({ uploadedAt: settings.get("rrp_uploaded_at") ?? null, count: Number(settings.get("rrp_count") ?? 0) });
});

router.get("/rrp-data", async (_req, res): Promise<void> => {
  const cached = memCache.get("rrp");
  if (cached) { sendCompressed(res, cached); return; }

  const gz = await getSetting("rrp_gz");
  if (gz) {
    const buf = Buffer.from(gz, "base64");
    memCache.set("rrp", buf);
    sendCompressed(res, buf);
    return;
  }

  const settings = await getSettings(["rrp_by_item_json", "rrp_uploaded_at", "rrp_count"]);
  const byItemJson = settings.get("rrp_by_item_json");
  const payload = JSON.stringify({
    byItem: byItemJson ? JSON.parse(byItemJson) : {},
    uploadedAt: settings.get("rrp_uploaded_at") ?? null,
    count: Number(settings.get("rrp_count") ?? 0),
  });
  const buf = await storeCompressed("rrp", payload);
  sendCompressed(res, buf);
});

async function saveRrp(byItem: Record<string, unknown>, count: number, now: string): Promise<void> {
  const payload = JSON.stringify({ byItem, uploadedAt: now, count });
  await Promise.all([
    setSetting("rrp_by_item_json", JSON.stringify(byItem)),
    setSetting("rrp_uploaded_at", now),
    setSetting("rrp_count", String(count)),
    storeCompressed("rrp", payload),
  ]);
}

router.post("/rrp-data", async (req, res): Promise<void> => {
  const { byItem, count } = req.body as { byItem?: Record<string, unknown>; count?: number };
  if (!byItem || Object.keys(byItem).length === 0) { res.status(400).json({ error: "byItem is required" }); return; }
  const now = new Date().toISOString();
  const itemCount = count ?? Object.keys(byItem).length;
  try { await saveRrp(byItem, itemCount, now); } catch { res.status(500).json({ error: "Failed to save RRP data. Please try again." }); return; }
  res.json({ ok: true, uploadedAt: now, count: itemCount });
});

router.post("/admin/rrp-data", async (req, res): Promise<void> => {
  if (!checkAdminPassword(req, res)) return;
  const { byItem, count } = req.body as { byItem?: Record<string, unknown>; count?: number };
  if (!byItem || Object.keys(byItem).length === 0) { res.status(400).json({ error: "byItem is required" }); return; }
  const now = new Date().toISOString();
  const itemCount = count ?? Object.keys(byItem).length;
  try { await saveRrp(byItem, itemCount, now); } catch { res.status(500).json({ error: "Failed to save RRP data. Please try again." }); return; }
  res.json({ ok: true, uploadedAt: now, count: itemCount });
});

router.delete("/admin/rrp-data", async (req, res): Promise<void> => {
  if (!checkAdminPassword(req, res)) return;
  memCache.delete("rrp");
  for (const key of ["rrp_by_item_json", "rrp_uploaded_at", "rrp_count", "rrp_gz"]) {
    await db.delete(appSettingsTable).where(eq(appSettingsTable.key, key));
  }
  res.json({ ok: true });
});

// ── Specials Data ─────────────────────────────────────────────────────────────

router.get("/specials-data/meta", async (_req, res): Promise<void> => {
  const settings = await getSettings(["specials_uploaded_at", "specials_count"]);
  res.setHeader("Cache-Control", "no-store");
  res.json({ uploadedAt: settings.get("specials_uploaded_at") ?? null, count: Number(settings.get("specials_count") ?? 0) });
});

router.get("/specials-data", async (_req, res): Promise<void> => {
  const cached = memCache.get("specials");
  if (cached) { sendCompressed(res, cached); return; }

  const gz = await getSetting("specials_gz");
  if (gz) {
    const buf = Buffer.from(gz, "base64");
    memCache.set("specials", buf);
    sendCompressed(res, buf);
    return;
  }

  const settings = await getSettings(["specials_by_item_json", "specials_uploaded_at", "specials_count"]);
  const byItemJson = settings.get("specials_by_item_json");
  const payload = JSON.stringify({
    byItem: byItemJson ? JSON.parse(byItemJson) : {},
    uploadedAt: settings.get("specials_uploaded_at") ?? null,
    count: Number(settings.get("specials_count") ?? 0),
  });
  const buf = await storeCompressed("specials", payload);
  sendCompressed(res, buf);
});

async function saveSpecials(byItem: Record<string, unknown>, count: number, now: string): Promise<void> {
  const payload = JSON.stringify({ byItem, uploadedAt: now, count });
  await Promise.all([
    setSetting("specials_by_item_json", JSON.stringify(byItem)),
    setSetting("specials_uploaded_at", now),
    setSetting("specials_count", String(count)),
    storeCompressed("specials", payload),
  ]);
}

router.post("/specials-data", async (req, res): Promise<void> => {
  const { byItem, count } = req.body as { byItem?: Record<string, unknown>; count?: number };
  if (!byItem || Object.keys(byItem).length === 0) { res.status(400).json({ error: "byItem is required" }); return; }
  const now = new Date().toISOString();
  const itemCount = count ?? Object.keys(byItem).length;
  try { await saveSpecials(byItem, itemCount, now); } catch { res.status(500).json({ error: "Failed to save specials data. Please try again." }); return; }
  res.json({ ok: true, uploadedAt: now, count: itemCount });
});

router.post("/admin/specials-data", async (req, res): Promise<void> => {
  if (!checkAdminPassword(req, res)) return;
  const { byItem, count } = req.body as { byItem?: Record<string, unknown>; count?: number };
  if (!byItem || Object.keys(byItem).length === 0) { res.status(400).json({ error: "byItem is required" }); return; }
  const now = new Date().toISOString();
  const itemCount = count ?? Object.keys(byItem).length;
  try { await saveSpecials(byItem, itemCount, now); } catch { res.status(500).json({ error: "Failed to save specials data. Please try again." }); return; }
  res.json({ ok: true, uploadedAt: now, count: itemCount });
});

router.delete("/admin/specials-data", async (req, res): Promise<void> => {
  if (!checkAdminPassword(req, res)) return;
  memCache.delete("specials");
  for (const key of ["specials_by_item_json", "specials_uploaded_at", "specials_count", "specials_gz"]) {
    await db.delete(appSettingsTable).where(eq(appSettingsTable.key, key));
  }
  res.json({ ok: true });
});

// ── SOH Data ──────────────────────────────────────────────────────────────────

router.get("/soh-data/meta", async (_req, res): Promise<void> => {
  const settings = await getSettings(["soh_uploaded_at", "soh_count"]);
  res.setHeader("Cache-Control", "no-store");
  res.json({ uploadedAt: settings.get("soh_uploaded_at") ?? null, count: Number(settings.get("soh_count") ?? 0) });
});

router.get("/soh-data", async (_req, res): Promise<void> => {
  const cached = memCache.get("soh");
  if (cached) { sendCompressed(res, cached); return; }

  const gz = await getSetting("soh_gz");
  if (gz) {
    const buf = Buffer.from(gz, "base64");
    memCache.set("soh", buf);
    sendCompressed(res, buf);
    return;
  }

  const settings = await getSettings(["soh_by_barcode_json", "soh_by_item_json", "soh_by_store_json", "soh_by_region_json", "soh_uploaded_at", "soh_count"]);
  const payload = JSON.stringify({
    byBarcode: settings.get("soh_by_barcode_json") ? JSON.parse(settings.get("soh_by_barcode_json")!) : {},
    byItem: settings.get("soh_by_item_json") ? JSON.parse(settings.get("soh_by_item_json")!) : {},
    byStore: settings.get("soh_by_store_json") ? JSON.parse(settings.get("soh_by_store_json")!) : {},
    byRegion: settings.get("soh_by_region_json") ? JSON.parse(settings.get("soh_by_region_json")!) : {},
    uploadedAt: settings.get("soh_uploaded_at") ?? null,
    count: Number(settings.get("soh_count") ?? 0),
  });
  const buf = await storeCompressed("soh", payload);
  sendCompressed(res, buf);
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
  if (!byBarcode && !byItem) { res.status(400).json({ error: "byBarcode or byItem is required" }); return; }
  const now = new Date().toISOString();
  const itemCount = count ?? Math.max(Object.keys(byBarcode ?? {}).length, Object.keys(byItem ?? {}).length);
  const payload = JSON.stringify({
    byBarcode: byBarcode ?? {},
    byItem: byItem ?? {},
    byStore: byStore ?? {},
    byRegion: byRegion ?? {},
    uploadedAt: now,
    count: itemCount,
  });
  await Promise.all([
    setSetting("soh_by_barcode_json", JSON.stringify(byBarcode ?? {})),
    setSetting("soh_by_item_json", JSON.stringify(byItem ?? {})),
    setSetting("soh_by_store_json", JSON.stringify(byStore ?? {})),
    setSetting("soh_by_region_json", JSON.stringify(byRegion ?? {})),
    setSetting("soh_uploaded_at", now),
    setSetting("soh_count", String(itemCount)),
    storeCompressed("soh", payload),
  ]);
  res.json({ ok: true, uploadedAt: now, count: itemCount });
});

router.delete("/admin/soh-data", async (req, res): Promise<void> => {
  if (!checkAdminPassword(req, res)) return;
  memCache.delete("soh");
  for (const key of ["soh_by_barcode_json", "soh_by_item_json", "soh_by_store_json", "soh_by_region_json", "soh_uploaded_at", "soh_count", "soh_gz"]) {
    await db.delete(appSettingsTable).where(eq(appSettingsTable.key, key));
  }
  res.json({ ok: true });
});

export default router;
