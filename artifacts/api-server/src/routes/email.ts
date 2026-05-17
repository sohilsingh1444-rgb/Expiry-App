import { Router, type IRouter } from "express";
import nodemailer from "nodemailer";
import { eq, gte } from "drizzle-orm";
import { db, storesTable, expiryScansTable } from "@workspace/db";
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

function weeklyReportHtml(opts: {
  storeCode: string;
  storeName: string;
  weekStart: string;
  weekEnd: string;
  total: number;
  totalQty: number;
  expired: number;
  urgent: number;
  nearExpiry: number;
  ok: number;
  complianceFlags: number;
  topItems: { description: string; barcode: string; status: string; qty: number; expiryDate: string }[];
}) {
  const { storeCode, storeName, weekStart, weekEnd, total, totalQty, expired, urgent, nearExpiry, ok, complianceFlags, topItems } = opts;

  const statusColor = (s: string) =>
    s === "Expired" ? "#dc2626" : s === "Urgent" ? "#ea580c" : s === "Near Expiry" ? "#d97706" : "#16a34a";

  const topRows = topItems
    .slice(0, 20)
    .map(
      (i) =>
        `<tr style="border-bottom:1px solid #f0f0f0">
          <td style="padding:6px 10px;font-size:13px">${i.description || i.barcode}</td>
          <td style="padding:6px 10px;font-size:13px;text-align:center">${i.qty}</td>
          <td style="padding:6px 10px;font-size:13px;text-align:center">${i.expiryDate}</td>
          <td style="padding:6px 10px;font-size:13px;text-align:center;color:${statusColor(i.status)};font-weight:600">${i.status}</td>
        </tr>`,
    )
    .join("");

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Inter,Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 0">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
        <!-- Header -->
        <tr><td style="background:#111827;padding:28px 32px">
          <div style="color:#f59e0b;font-size:18px;font-weight:700;letter-spacing:-0.3px">⏱ Expiry Tracker</div>
          <div style="color:#ffffff;font-size:22px;font-weight:700;margin-top:4px">Weekly Report</div>
          <div style="color:#9ca3af;font-size:13px;margin-top:2px">${storeName} (${storeCode}) · ${weekStart} – ${weekEnd}</div>
        </td></tr>
        <!-- Summary cards -->
        <tr><td style="padding:24px 32px 8px">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td width="25%" style="padding:4px">
                <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:14px;text-align:center">
                  <div style="font-size:24px;font-weight:700;color:#111827">${total}</div>
                  <div style="font-size:11px;color:#6b7280;margin-top:2px;text-transform:uppercase;letter-spacing:.5px">Total Scans</div>
                </div>
              </td>
              <td width="25%" style="padding:4px">
                <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:14px;text-align:center">
                  <div style="font-size:24px;font-weight:700;color:#dc2626">${expired}</div>
                  <div style="font-size:11px;color:#dc2626;margin-top:2px;text-transform:uppercase;letter-spacing:.5px">Expired</div>
                </div>
              </td>
              <td width="25%" style="padding:4px">
                <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:14px;text-align:center">
                  <div style="font-size:24px;font-weight:700;color:#ea580c">${urgent}</div>
                  <div style="font-size:11px;color:#ea580c;margin-top:2px;text-transform:uppercase;letter-spacing:.5px">Urgent</div>
                </div>
              </td>
              <td width="25%" style="padding:4px">
                <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:14px;text-align:center">
                  <div style="font-size:24px;font-weight:700;color:#d97706">${nearExpiry}</div>
                  <div style="font-size:11px;color:#d97706;margin-top:2px;text-transform:uppercase;letter-spacing:.5px">Near Expiry</div>
                </div>
              </td>
            </tr>
          </table>
        </td></tr>
        <!-- Extra stats -->
        <tr><td style="padding:8px 32px 24px">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td width="50%" style="padding:4px">
                <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:12px;text-align:center">
                  <div style="font-size:20px;font-weight:700;color:#16a34a">${ok}</div>
                  <div style="font-size:11px;color:#16a34a;margin-top:2px;text-transform:uppercase;letter-spacing:.5px">OK Items</div>
                </div>
              </td>
              <td width="50%" style="padding:4px">
                <div style="background:#faf5ff;border:1px solid #e9d5ff;border-radius:8px;padding:12px;text-align:center">
                  <div style="font-size:20px;font-weight:700;color:#7c3aed">${complianceFlags}</div>
                  <div style="font-size:11px;color:#7c3aed;margin-top:2px;text-transform:uppercase;letter-spacing:.5px">Compliance Flags</div>
                </div>
              </td>
            </tr>
          </table>
        </td></tr>
        ${
          topItems.length > 0
            ? `<!-- Top items table -->
        <tr><td style="padding:0 32px 24px">
          <div style="font-size:14px;font-weight:600;color:#374151;margin-bottom:10px">Items Requiring Attention (Expired &amp; Urgent)</div>
          <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">
            <thead>
              <tr style="background:#f9fafb">
                <th style="padding:8px 10px;font-size:11px;font-weight:600;color:#6b7280;text-align:left;text-transform:uppercase;letter-spacing:.5px">Item</th>
                <th style="padding:8px 10px;font-size:11px;font-weight:600;color:#6b7280;text-align:center;text-transform:uppercase;letter-spacing:.5px">Qty</th>
                <th style="padding:8px 10px;font-size:11px;font-weight:600;color:#6b7280;text-align:center;text-transform:uppercase;letter-spacing:.5px">Expiry</th>
                <th style="padding:8px 10px;font-size:11px;font-weight:600;color:#6b7280;text-align:center;text-transform:uppercase;letter-spacing:.5px">Status</th>
              </tr>
            </thead>
            <tbody>${topRows}</tbody>
          </table>
        </td></tr>`
            : ""
        }
        <!-- Total qty -->
        <tr><td style="padding:0 32px 24px">
          <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:14px;display:flex;justify-content:space-between;align-items:center">
            <span style="font-size:13px;color:#6b7280">Total quantity scanned this week</span>
            <span style="font-size:18px;font-weight:700;color:#111827">${totalQty.toFixed(0)} units</span>
          </div>
        </td></tr>
        <!-- Footer -->
        <tr><td style="background:#f9fafb;padding:16px 32px;border-top:1px solid #e5e7eb">
          <div style="font-size:11px;color:#9ca3af;text-align:center">
            Generated by Expiry Tracker · ${new Date().toLocaleDateString("en-FJ", { timeZone: "Pacific/Fiji", weekday: "long", year: "numeric", month: "long", day: "numeric" })}
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

router.get("/email/weekly-report", async (req, res): Promise<void> => {
  const adminPw = req.headers["x-admin-password"];
  const cronSecret = req.headers["authorization"];
  const isAdmin = adminPw === process.env.ADMIN_PASSWORD;
  const isCron =
    process.env.CRON_SECRET && cronSecret === `Bearer ${process.env.CRON_SECRET}`;

  if (!isAdmin && !isCron) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const daysBack = Math.min(365, Math.max(1, parseInt(String(req.query.days ?? "7"), 10) || 7));
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - daysBack);
  const sevenDaysAgoStr = sevenDaysAgo.toISOString().split("T")[0]!;

  const scans = await db
    .select()
    .from(expiryScansTable)
    .where(gte(expiryScansTable.scanDate, sevenDaysAgoStr));

  if (!scans.length) {
    res.json({ ok: true, message: "No scans in the past 7 days. No emails sent." });
    return;
  }

  const byStore = new Map<string, typeof scans>();
  for (const scan of scans) {
    const arr = byStore.get(scan.storeLocation) ?? [];
    arr.push(scan);
    byStore.set(scan.storeLocation, arr);
  }

  const transporter = createTransporter();
  const smtpUser = process.env.SMTP_USER ?? process.env.GMAIL_USER;

  if (!transporter || !smtpUser) {
    res.status(503).json({ error: "Email credentials not configured on server." });
    return;
  }

  await ensureStoresSeeded();
  const results: { store: string; status: string; recipients?: string[] }[] = [];

  for (const [storeCode, storeScans] of byStore) {
    const [store] = await db
      .select()
      .from(storesTable)
      .where(eq(storesTable.code, storeCode));
    const recipients = store?.emails ?? [];

    if (!recipients.length) {
      results.push({ store: storeCode, status: "no-recipients" });
      continue;
    }

    const expired = storeScans.filter((s) => s.status === "Expired").length;
    const urgent = storeScans.filter((s) => s.status === "Urgent").length;
    const nearExpiry = storeScans.filter((s) => s.status === "Near Expiry").length;
    const ok = storeScans.filter((s) => s.status === "OK").length;
    const totalQty = storeScans.reduce((sum, s) => sum + s.qty, 0);
    const complianceFlags = storeScans.filter(
      (s) => s.wrongRrp || s.missingSpecialTicket || s.notOnDisplay,
    ).length;

    const topItems = storeScans
      .filter((s) => s.status === "Expired" || s.status === "Urgent")
      .sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0))
      .map((s) => ({
        description: s.description ?? "",
        barcode: s.barcode,
        status: s.status,
        qty: s.qty,
        expiryDate: s.expiryDate,
      }));

    const weekEnd = new Date().toISOString().split("T")[0]!;

    const html = weeklyReportHtml({
      storeCode,
      storeName: store?.name ?? storeCode,
      weekStart: sevenDaysAgoStr,
      weekEnd,
      total: storeScans.length,
      totalQty,
      expired,
      urgent,
      nearExpiry,
      ok,
      complianceFlags,
      topItems,
    });

    await transporter.sendMail({
      from: `"Expiry Tracker" <${smtpUser}>`,
      to: recipients.join(", "),
      subject: `Weekly Expiry Report — ${storeCode} — ${sevenDaysAgoStr} to ${weekEnd}`,
      html,
    });

    results.push({ store: storeCode, status: "sent", recipients });
  }

  res.json({ ok: true, results });
});

export default router;
