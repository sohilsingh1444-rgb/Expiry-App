import { Router, type IRouter } from "express";
import nodemailer from "nodemailer";
import { eq } from "drizzle-orm";
import { db, storesTable } from "@workspace/db";
import { ensureStoresSeeded } from "./admin";

const router: IRouter = Router();

function createTransporter() {
  const smtpUser = process.env.SMTP_USER ?? process.env.GMAIL_USER;
  const smtpPass = process.env.SMTP_PASS ?? process.env.GMAIL_APP_PASSWORD;

  if (!smtpUser || !smtpPass) return null;

  const isOutlook = smtpUser.includes("newworld.com.fj") || smtpUser.includes("outlook") || smtpUser.includes("hotmail");

  if (isOutlook) {
    return nodemailer.createTransport({
      host: "smtp.office365.com",
      port: 587,
      secure: false,
      auth: { user: smtpUser, pass: smtpPass },
      tls: { ciphers: "SSLv3" },
    });
  }

  return nodemailer.createTransport({
    service: "gmail",
    auth: { user: smtpUser, pass: smtpPass },
  });
}

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

  const smtpUser = process.env.SMTP_USER ?? process.env.GMAIL_USER;
  const transporter = createTransporter();

  if (!transporter || !smtpUser) {
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

  const buffer = Buffer.from(fileBase64, "base64");

  await transporter.sendMail({
    from: `"Expiry Tracker" <${smtpUser}>`,
    to: recipients.join(", "),
    subject: `Expiry Scan Report — ${storeLocation} — ${pdUserName} — ${scanDate}`,
    text: `Please find attached the expiry scan report for ${storeLocation} by ${pdUserName} on ${scanDate}.`,
    attachments: [{ filename, content: buffer }],
  });

  res.json({ ok: true, recipients });
});

export default router;
