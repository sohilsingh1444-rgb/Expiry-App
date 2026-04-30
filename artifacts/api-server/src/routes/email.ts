import { Router, type IRouter } from "express";
import nodemailer from "nodemailer";
import { eq } from "drizzle-orm";
import { db, storesTable } from "@workspace/db";
import { ensureStoresSeeded } from "./admin";

const router: IRouter = Router();

router.get("/email/store-recipients", async (req, res): Promise<void> => {
  const { storeLocation } = req.query as { storeLocation?: string };
  if (!storeLocation) {
    res.status(400).json({ error: "storeLocation is required" });
    return;
  }
  await ensureStoresSeeded();
  const key = storeLocation.toUpperCase();
  const [store] = await db.select().from(storesTable).where(eq(storesTable.code, key));
  res.json({ storeLocation: key, emails: store?.emails ?? [] });
});

router.post("/email/send-export", async (req, res): Promise<void> => {
  const { storeLocation, pdUserName, scanDate, filename, fileBase64 } = req.body as {
    storeLocation?: string;
    pdUserName?: string;
    scanDate?: string;
    filename?: string;
    fileBase64?: string;
  };

  if (!storeLocation || !pdUserName || !scanDate || !filename || !fileBase64) {
    res.status(400).json({ error: "Missing required fields: storeLocation, pdUserName, scanDate, filename, fileBase64" });
    return;
  }

  const gmailUser = process.env.GMAIL_USER;
  const gmailPass = process.env.GMAIL_APP_PASSWORD;

  if (!gmailUser || !gmailPass) {
    res.status(503).json({ error: "Email credentials not configured on server." });
    return;
  }

  await ensureStoresSeeded();
  const key = storeLocation.toUpperCase();
  const [store] = await db.select().from(storesTable).where(eq(storesTable.code, key));
  const recipients = store?.emails ?? [];

  if (!recipients.length) {
    res.status(404).json({ error: `No email recipients configured for store ${key}. Add them in the Admin panel.` });
    return;
  }

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: gmailUser, pass: gmailPass },
  });

  const buffer = Buffer.from(fileBase64, "base64");

  await transporter.sendMail({
    from: `"Expiry Tracker" <${gmailUser}>`,
    to: recipients.join(", "),
    subject: `Expiry Scan Report — ${storeLocation} — ${pdUserName} — ${scanDate}`,
    text: `Please find attached the expiry scan report for ${storeLocation} by ${pdUserName} on ${scanDate}.`,
    attachments: [{ filename, content: buffer }],
  });

  res.json({ ok: true, recipients });
});

export default router;
