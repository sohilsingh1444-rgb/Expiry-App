import { Router, type IRouter } from "express";
import nodemailer from "nodemailer";

const router: IRouter = Router();

const STORE_EMAILS: Record<string, string[]> = {
  S0001: ["nwlba1@newworld.com.fj", "mgr_ba1@newworld.com.fj"],
  S0003: ["nwlba3@newworld.com.fj"],
  S0005: ["nwlada@newworld.com.fj"],
  S0006: ["nwlnad@newworld.com.fj"],
  S0010: ["nwlnts@newworld.com.fj"],
  S0011: ["igasup@newworld.com.fj"],
  S0013: ["nwlrak@newworld.com.fj"],
  S0014: ["nwllab@newworld.com.fj"],
  S0016: ["igasavusavu@newworld.com.fj"],
  S0018: ["igaltk@newworld.com.fj"],
  S0019: ["iganak@newworld.com.fj"],
  S0020: ["nwlnar@newworld.com.fj"],
  S0021: ["nwlnau@newworld.com.fj"],
  S0025: ["nwltav@newworld.com.fj"],
  S0026: ["nwlvit@newworld.com.fj"],
  S0029: ["igadcc@newworld.com.fj"],
  S0033: ["igagst@newworld.com.fj"],
  S0035: ["igawaiyavi@newworld.com.fj"],
  S0036: ["iganad@newworld.com.fj"],
};

router.get("/email/store-recipients", (req, res) => {
  const { storeLocation } = req.query as { storeLocation?: string };
  if (!storeLocation) {
    res.status(400).json({ error: "storeLocation is required" });
    return;
  }
  const key = storeLocation.toUpperCase();
  const emails = STORE_EMAILS[key] ?? [];
  res.json({ storeLocation: key, emails });
});

router.post("/email/send-export", async (req, res): Promise<void> => {
  const { storeLocation, pdUserName, scanDate, filename, fileBase64 } = req.body as {
    storeLocation: string;
    pdUserName: string;
    scanDate: string;
    filename: string;
    fileBase64: string;
  };

  if (!storeLocation || !filename || !fileBase64) {
    res.status(400).json({ error: "storeLocation, filename, and fileBase64 are required" });
    return;
  }

  const gmailUser = process.env.GMAIL_USER;
  const gmailPass = process.env.GMAIL_APP_PASSWORD;

  if (!gmailUser || !gmailPass) {
    res.status(503).json({ error: "Email sending is not configured. Set GMAIL_USER and GMAIL_APP_PASSWORD." });
    return;
  }

  const key = storeLocation.toUpperCase();
  const toEmails = STORE_EMAILS[key];
  if (!toEmails || toEmails.length === 0) {
    res.status(404).json({ error: `No email address configured for store ${storeLocation}` });
    return;
  }

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: gmailUser,
      pass: gmailPass,
    },
  });

  const buffer = Buffer.from(fileBase64, "base64");

  await transporter.sendMail({
    from: `"Expiry Scan" <${gmailUser}>`,
    to: toEmails.join(", "),
    subject: `Expiry Scan Report — ${storeLocation} — ${scanDate}`,
    text: `Hi,\n\nPlease find attached the expiry scan report for ${storeLocation} conducted by ${pdUserName} on ${scanDate}.\n\nThis report was sent automatically by the Expiry Scan app.\n\nRegards,\nExpiry Scan System`,
    attachments: [
      {
        filename,
        content: buffer,
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    ],
  });

  res.json({ sent: true, to: toEmails });
});

export default router;
