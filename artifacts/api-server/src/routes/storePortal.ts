import { Router, type IRouter, type Request, type Response } from "express";
import { createHmac, pbkdf2Sync, timingSafeEqual } from "crypto";
import { eq, like } from "drizzle-orm";
import { db, appSettingsTable } from "@workspace/db";

const router: IRouter = Router();

const DEFAULT_PASSWORD = "Newworld123";
const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;

function getSecret(): string {
  return process.env.SESSION_SECRET ?? "nwl_store_portal_fallback_2024";
}

function hashPassword(password: string, storeCode: string): string {
  return pbkdf2Sync(password, storeCode + "_nwl_soh_salt", 10000, 32, "sha256").toString("hex");
}

async function getSetting(key: string): Promise<string | null> {
  const [row] = await db.select().from(appSettingsTable).where(eq(appSettingsTable.key, key));
  return row?.value ?? null;
}

async function setSetting(key: string, value: string): Promise<void> {
  await db
    .insert(appSettingsTable)
    .values({ key, value })
    .onConflictDoUpdate({ target: appSettingsTable.key, set: { value, updatedAt: new Date() } });
}

function makeToken(storeCode: string): string {
  const ts = Date.now().toString();
  const sig = createHmac("sha256", getSecret())
    .update(`${storeCode}.${ts}`)
    .digest("hex");
  return Buffer.from(`${storeCode}.${ts}.${sig}`).toString("base64url");
}

function verifyToken(token: string): string | null {
  try {
    const decoded = Buffer.from(token, "base64url").toString();
    const firstDot = decoded.indexOf(".");
    const secondDot = decoded.indexOf(".", firstDot + 1);
    if (firstDot < 0 || secondDot < 0) return null;
    const storeCode = decoded.slice(0, firstDot);
    const ts = decoded.slice(firstDot + 1, secondDot);
    const sig = decoded.slice(secondDot + 1);
    const expected = createHmac("sha256", getSecret())
      .update(`${storeCode}.${ts}`)
      .digest("hex");
    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length) return null;
    if (!timingSafeEqual(sigBuf, expBuf)) return null;
    if (Date.now() - parseInt(ts) > TOKEN_TTL_MS) return null;
    return storeCode;
  } catch {
    return null;
  }
}

async function verifyPassword(storeCode: string, password: string): Promise<boolean> {
  const storedHash = await getSetting(`store_pwd_${storeCode}`);
  if (!storedHash) {
    return password === DEFAULT_PASSWORD;
  }
  const hash = hashPassword(password, storeCode);
  try {
    return timingSafeEqual(Buffer.from(hash), Buffer.from(storedHash));
  } catch {
    return false;
  }
}

function requireStoreAuth(req: Request, res: Response): string | null {
  const token = req.headers["x-store-token"] as string | undefined;
  if (!token) {
    res.status(401).json({ error: "Authentication required" });
    return null;
  }
  const storeCode = verifyToken(token);
  if (!storeCode) {
    res.status(401).json({ error: "Invalid or expired session. Please log in again." });
    return null;
  }
  return storeCode;
}

router.post("/store-portal/login", async (req, res): Promise<void> => {
  const { storeCode, password } = req.body as { storeCode?: string; password?: string };
  if (!storeCode || !password) {
    res.status(400).json({ error: "storeCode and password are required" });
    return;
  }
  const valid = await verifyPassword(storeCode, password);
  if (!valid) {
    res.status(401).json({ error: "Incorrect password" });
    return;
  }
  const token = makeToken(storeCode);
  const uploadedAt = await getSetting(`soh_store_${storeCode}_uploaded_at`);
  const count = await getSetting(`soh_store_${storeCode}_count`);
  res.json({ ok: true, token, uploadedAt, count: count ? parseInt(count) : null });
});

router.post("/store-portal/upload-soh", async (req, res): Promise<void> => {
  const storeCode = requireStoreAuth(req, res);
  if (!storeCode) return;

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

  await setSetting(`soh_store_${storeCode}_json`, JSON.stringify({ byBarcode: byBarcode ?? {}, byItem: byItem ?? {} }));
  await setSetting(`soh_store_${storeCode}_uploaded_at`, now);
  await setSetting(`soh_store_${storeCode}_count`, String(itemCount));

  const allSettings = await db
    .select()
    .from(appSettingsTable)
    .where(like(appSettingsTable.key, "soh_store_%_json"));

  const byStore: Record<string, unknown> = {};
  for (const entry of allSettings) {
    const code = entry.key.replace("soh_store_", "").replace("_json", "");
    try { byStore[code] = JSON.parse(entry.value); } catch {}
  }
  await setSetting("soh_by_store_json", JSON.stringify(byStore));

  res.json({ ok: true, uploadedAt: now, count: itemCount });
});

router.post("/store-portal/change-password", async (req, res): Promise<void> => {
  const storeCode = requireStoreAuth(req, res);
  if (!storeCode) return;

  const { currentPassword, newPassword } = req.body as {
    currentPassword?: string;
    newPassword?: string;
  };
  if (!currentPassword || !newPassword) {
    res.status(400).json({ error: "currentPassword and newPassword are required" });
    return;
  }
  if (newPassword.length < 6) {
    res.status(400).json({ error: "New password must be at least 6 characters" });
    return;
  }
  const valid = await verifyPassword(storeCode, currentPassword);
  if (!valid) {
    res.status(401).json({ error: "Current password is incorrect" });
    return;
  }
  const hash = hashPassword(newPassword, storeCode);
  await setSetting(`store_pwd_${storeCode}`, hash);
  res.json({ ok: true });
});

router.post("/store-portal/reset-password", async (req, res): Promise<void> => {
  const { storeCode } = req.body as { storeCode?: string };
  if (!storeCode) {
    res.status(400).json({ error: "storeCode is required" });
    return;
  }
  await db
    .delete(appSettingsTable)
    .where(eq(appSettingsTable.key, `store_pwd_${storeCode}`));
  res.json({ ok: true, message: `Password for ${storeCode} reset to default` });
});

router.get("/store-portal/soh-meta", async (req, res): Promise<void> => {
  const token = req.headers["x-store-token"] as string | undefined;
  const tokenCode = token ? verifyToken(token) : null;
  const code = tokenCode ?? (req.query["storeCode"] as string);
  if (!code) {
    res.status(400).json({ error: "storeCode required" });
    return;
  }
  const uploadedAt = await getSetting(`soh_store_${code}_uploaded_at`);
  const count = await getSetting(`soh_store_${code}_count`);
  res.json({ uploadedAt, count: count ? parseInt(count) : null });
});

export default router;
