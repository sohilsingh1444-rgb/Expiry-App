import { Router, type IRouter } from "express";
import nodemailer from "nodemailer";
import ExcelJS from "exceljs";
import { eq, gte } from "drizzle-orm";
import { db, storesTable, expiryScansTable } from "@workspace/db";
import { ensureStoresSeeded } from "./admin";

const router: IRouter = Router();

function createTransporter(pool = false) {
  const smtpUser = process.env.SMTP_USER ?? process.env.GMAIL_USER;
  const smtpPass = process.env.SMTP_PASS ?? process.env.GMAIL_APP_PASSWORD;

  if (!smtpUser || !smtpPass) return null;

  const isOutlook = smtpUser.includes("newworld.com.fj") || smtpUser.includes("outlook") || smtpUser.includes("hotmail");

  if (isOutlook) {
    return nodemailer.createTransport({
      host: "smtp.office365.com",
      port: 587,
      secure: false,
      pool,
      maxConnections: 1,
      maxMessages: Infinity,
      auth: { user: smtpUser, pass: smtpPass },
      tls: { ciphers: "SSLv3" },
    } as any);
  }

  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    pool,
    maxConnections: 1,
    maxMessages: Infinity,
    auth: { user: smtpUser, pass: smtpPass },
  } as any);
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

async function buildWeeklyExcel(
  scansByStore: Map<string, { storeCode: string; storeName: string; scans: any[] }>,
  weekStart: string,
  weekEnd: string,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Expiry Tracker";
  wb.created = new Date();

  // ── Styles ──────────────────────────────────────────────────────────────
  const hdrFill: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF111827" } };
  const redFill:  ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFEF2F2" } };
  const orgFill:  ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF7ED" } };
  const yelFill:  ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFBEB" } };
  const grnFill:  ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF0FDF4" } };

  const white   = { argb: "FFFFFFFF" } as ExcelJS.Color;
  const red700  = { argb: "FFDC2626" } as ExcelJS.Color;
  const org600  = { argb: "FFEA580C" } as ExcelJS.Color;
  const yel600  = { argb: "FFD97706" } as ExcelJS.Color;
  const grn600  = { argb: "FF16A34A" } as ExcelJS.Color;
  const gray700 = { argb: "FF374151" } as ExcelJS.Color;
  const gray500 = { argb: "FF6B7280" } as ExcelJS.Color;

  // ── Sheet 1: Summary ────────────────────────────────────────────────────
  const sum = wb.addWorksheet("Summary");
  sum.views = [{ state: "frozen", ySplit: 4 }];

  // Title rows
  sum.mergeCells("A1:J1");
  const t1 = sum.getCell("A1");
  t1.value = "EXPIRY TRACKER — WEEKLY REPORT (ALL STORES)";
  t1.font = { bold: true, size: 14, color: white };
  t1.fill = hdrFill;
  t1.alignment = { horizontal: "center", vertical: "middle" };
  sum.getRow(1).height = 26;

  sum.mergeCells("A2:J2");
  const t2 = sum.getCell("A2");
  t2.value = `Period: ${weekStart}  →  ${weekEnd}`;
  t2.font = { size: 11, color: { argb: "FF9CA3AF" } };
  t2.fill = hdrFill;
  t2.alignment = { horizontal: "center", vertical: "middle" };
  sum.getRow(2).height = 20;

  sum.addRow([]);

  const sumHdr = ["Store Name", "Code", "Region", "Total Scans", "Expired", "Urgent", "Near Expiry", "OK", "Total Qty", "Compliance Flags"];
  const sumHdrRow = sum.addRow(sumHdr);
  sumHdrRow.eachCell(cell => {
    cell.font = { bold: true, size: 11, color: white };
    cell.fill = hdrFill;
    cell.alignment = { horizontal: "center", vertical: "middle" };
    cell.border = { bottom: { style: "thin", color: { argb: "FF374151" } } };
  });
  sumHdrRow.height = 22;

  sum.columns = [
    { key: "name",    width: 30 },
    { key: "code",    width: 12 },
    { key: "region",  width: 10 },
    { key: "total",   width: 13 },
    { key: "expired", width: 11 },
    { key: "urgent",  width: 11 },
    { key: "near",    width: 14 },
    { key: "ok",      width: 10 },
    { key: "qty",     width: 13 },
    { key: "flags",   width: 18 },
  ];

  const storeSummaries = [...scansByStore.values()];
  for (const { storeCode, storeName, scans } of storeSummaries) {
    const expired    = scans.filter(s => s.status === "Expired").length;
    const urgent     = scans.filter(s => s.status === "Urgent").length;
    const nearExpiry = scans.filter(s => s.status === "Near Expiry").length;
    const ok         = scans.filter(s => s.status === "OK").length;
    const totalQty   = scans.reduce((n: number, s: any) => n + (s.qty ?? 0), 0);
    const flags      = scans.filter((s: any) => s.wrongRrp || s.missingSpecialTicket || s.notOnDisplay).length;
    const region     = scans[0]?.region ?? "";

    const row = sum.addRow([storeName, storeCode, region, scans.length, expired, urgent, nearExpiry, ok, totalQty, flags]);
    row.height = 19;

    const applyCell = (col: number, fill: ExcelJS.Fill, color: ExcelJS.Color) => {
      const c = row.getCell(col);
      c.fill = fill;
      c.font = { bold: true, color };
      c.alignment = { horizontal: "center" };
    };

    applyCell(4, { type: "pattern", pattern: "solid", fgColor: { argb: "FFF9FAFB" } }, gray700);
    applyCell(5, redFill, red700);
    applyCell(6, orgFill, org600);
    applyCell(7, yelFill, yel600);
    applyCell(8, grnFill, grn600);
    row.getCell(9).alignment = { horizontal: "center" };
    row.getCell(10).alignment = { horizontal: "center" };
    row.getCell(1).font = { bold: true, color: gray700 };
    row.getCell(2).font = { color: gray500 };
    row.getCell(2).alignment = { horizontal: "center" };
    row.getCell(3).alignment = { horizontal: "center" };
  }

  // Totals row
  const lastRow = sum.lastRow!.number;
  const totRow = sum.addRow([
    "TOTAL", "", "",
    { formula: `SUM(D5:D${lastRow})` },
    { formula: `SUM(E5:E${lastRow})` },
    { formula: `SUM(F5:F${lastRow})` },
    { formula: `SUM(G5:G${lastRow})` },
    { formula: `SUM(H5:H${lastRow})` },
    { formula: `SUM(I5:I${lastRow})` },
    { formula: `SUM(J5:J${lastRow})` },
  ]);
  totRow.eachCell(cell => {
    cell.font = { bold: true, size: 12, color: white };
    cell.fill = hdrFill;
    cell.alignment = { horizontal: "center", vertical: "middle" };
  });
  totRow.getCell(1).alignment = { horizontal: "left" };
  totRow.height = 22;

  // ── Per-store sheets ─────────────────────────────────────────────────────
  for (const { storeCode, storeName, scans } of storeSummaries) {
    const sheetName = storeCode.replace(/[:\\/?*\[\]]/g, "-").slice(0, 31);
    const ws = wb.addWorksheet(sheetName);
    ws.views = [{ state: "frozen", ySplit: 3 }];

    ws.mergeCells("A1:L1");
    const sh1 = ws.getCell("A1");
    sh1.value = `${storeName} (${storeCode}) — ${weekStart} to ${weekEnd}`;
    sh1.font = { bold: true, size: 13, color: white };
    sh1.fill = hdrFill;
    sh1.alignment = { horizontal: "center", vertical: "middle" };
    ws.getRow(1).height = 24;
    ws.addRow([]);

    const cols = ["Barcode", "Item No.", "Description", "Qty", "Expiry Date", "Scan Date", "Days Left", "Status", "Action Required", "Wrong RRP", "Missing Ticket", "Not on Display"];
    const hRow = ws.addRow(cols);
    hRow.eachCell(cell => {
      cell.font = { bold: true, size: 10, color: white };
      cell.fill = hdrFill;
      cell.alignment = { horizontal: "center", wrapText: true };
    });
    hRow.height = 20;

    ws.columns = [
      { width: 16 }, { width: 12 }, { width: 32 }, { width: 8 },
      { width: 13 }, { width: 13 }, { width: 11 }, { width: 14 },
      { width: 18 }, { width: 12 }, { width: 14 }, { width: 14 },
    ];

    const statusFills: Record<string, ExcelJS.Fill> = {
      "Expired":    redFill,
      "Urgent":     orgFill,
      "Near Expiry": yelFill,
      "OK":         grnFill,
    };
    const statusColors: Record<string, ExcelJS.Color> = {
      "Expired":    red700,
      "Urgent":     org600,
      "Near Expiry": yel600,
      "OK":         grn600,
    };

    const sorted = [...scans].sort((a, b) => {
      const order: Record<string, number> = { Expired: 0, Urgent: 1, "Near Expiry": 2, OK: 3 };
      return (order[a.status] ?? 9) - (order[b.status] ?? 9);
    });

    for (const s of sorted) {
      const r = ws.addRow([
        s.barcode, s.itemNumber ?? "", s.description ?? "",
        s.qty, s.expiryDate, s.scanDate,
        s.daysLeft ?? "", s.status, s.actionRequired ?? "",
        s.wrongRrp ? "Yes" : "", s.missingSpecialTicket ? "Yes" : "", s.notOnDisplay ? "Yes" : "",
      ]);
      r.height = 18;
      const fill = statusFills[s.status] ?? { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFFFF" } } as ExcelJS.Fill;
      const color = statusColors[s.status] ?? gray700;
      const statusCell = r.getCell(8);
      statusCell.fill = fill;
      statusCell.font = { bold: true, color };
      statusCell.alignment = { horizontal: "center" };
      r.getCell(4).alignment = { horizontal: "center" };
      r.getCell(7).alignment = { horizontal: "center" };
    }
  }

  return wb.xlsx.writeBuffer() as unknown as Promise<Buffer>;
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

  const managementEmail = process.env.MANAGEMENT_EMAIL ?? "sohil.singh@newworld.com.fj";
  const daysBack = Math.min(365, Math.max(1, parseInt(String(req.query.days ?? "7"), 10) || 7));
  const storeFilter = req.query.store ? String(req.query.store).toUpperCase() : null;

  const since = new Date();
  since.setDate(since.getDate() - daysBack);
  const sinceStr = since.toISOString().split("T")[0]!;
  const weekEnd  = new Date().toISOString().split("T")[0]!;

  const allScans = await db.select().from(expiryScansTable).where(gte(expiryScansTable.scanDate, sinceStr));
  const scans = storeFilter ? allScans.filter(s => s.storeLocation.toUpperCase() === storeFilter) : allScans;

  if (!scans.length) {
    res.json({ ok: true, message: `No scans found${storeFilter ? ` for ${storeFilter}` : ""} in the past ${daysBack} days. No email sent.` });
    return;
  }

  const transporter = createTransporter();
  const smtpUser = process.env.SMTP_USER ?? process.env.GMAIL_USER;
  if (!transporter || !smtpUser) {
    res.status(503).json({ error: "Email credentials not configured on server." });
    return;
  }

  await ensureStoresSeeded();
  const allStoreRows = await db.select().from(storesTable);
  const storeMap = new Map(allStoreRows.map(s => [s.code, s]));

  // Group scans by store
  const scansByStore = new Map<string, { storeCode: string; storeName: string; scans: any[] }>();
  for (const scan of scans) {
    const entry = scansByStore.get(scan.storeLocation) ?? {
      storeCode: scan.storeLocation,
      storeName: storeMap.get(scan.storeLocation)?.name ?? scan.storeLocation,
      scans: [],
    };
    entry.scans.push(scan);
    scansByStore.set(scan.storeLocation, entry);
  }

  // Build per-store stats for HTML summary
  type StoreStat = { code: string; name: string; total: number; expired: number; urgent: number; nearExpiry: number; ok: number; totalQty: number; compliance: number };
  const storeStats: StoreStat[] = [...scansByStore.values()].map(({ storeCode, storeName, scans: ss }) => ({
    code: storeCode,
    name: storeName,
    total: ss.length,
    expired:    ss.filter(s => s.status === "Expired").length,
    urgent:     ss.filter(s => s.status === "Urgent").length,
    nearExpiry: ss.filter(s => s.status === "Near Expiry").length,
    ok:         ss.filter(s => s.status === "OK").length,
    totalQty:   ss.reduce((n, s) => n + (s.qty ?? 0), 0),
    compliance: ss.filter(s => s.wrongRrp || s.missingSpecialTicket || s.notOnDisplay).length,
  }));

  const netTotal    = storeStats.reduce((n, s) => n + s.total, 0);
  const netExpired  = storeStats.reduce((n, s) => n + s.expired, 0);
  const netUrgent   = storeStats.reduce((n, s) => n + s.urgent, 0);
  const netNear     = storeStats.reduce((n, s) => n + s.nearExpiry, 0);

  const tableRows = storeStats.map(r => `
    <tr style="border-bottom:1px solid #f0f0f0">
      <td style="padding:7px 10px;font-size:13px;font-weight:600;color:#111827">${r.name}</td>
      <td style="padding:7px 6px;font-size:11px;color:#6b7280;text-align:center">${r.code}</td>
      <td style="padding:7px 6px;font-size:13px;text-align:center;font-weight:600;color:#111827">${r.total}</td>
      <td style="padding:7px 6px;font-size:13px;text-align:center;font-weight:700;color:#dc2626">${r.expired}</td>
      <td style="padding:7px 6px;font-size:13px;text-align:center;font-weight:700;color:#ea580c">${r.urgent}</td>
      <td style="padding:7px 6px;font-size:13px;text-align:center;color:#d97706">${r.nearExpiry}</td>
      <td style="padding:7px 6px;font-size:13px;text-align:center;color:#16a34a">${r.ok}</td>
      <td style="padding:7px 6px;font-size:12px;text-align:center;color:#6b7280">${r.totalQty}</td>
      <td style="padding:7px 6px;font-size:12px;text-align:center;color:#7c3aed">${r.compliance}</td>
    </tr>`).join("");

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Inter,Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 0">
    <tr><td align="center">
      <table width="700" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
        <tr><td style="background:#111827;padding:28px 32px">
          <div style="color:#f59e0b;font-size:18px;font-weight:700">⏱ Expiry Tracker</div>
          <div style="color:#fff;font-size:22px;font-weight:700;margin-top:4px">Weekly Report — All Stores</div>
          <div style="color:#9ca3af;font-size:13px;margin-top:2px">${sinceStr} – ${weekEnd} &nbsp;·&nbsp; ${storeStats.length} stores &nbsp;·&nbsp; Excel attached</div>
        </td></tr>
        <tr><td style="padding:24px 32px 16px">
          <table width="100%" cellpadding="0" cellspacing="0"><tr>
            <td width="25%" style="padding:4px"><div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:14px;text-align:center">
              <div style="font-size:26px;font-weight:700;color:#111827">${netTotal}</div>
              <div style="font-size:11px;color:#6b7280;margin-top:2px;text-transform:uppercase;letter-spacing:.5px">Total Scans</div>
            </div></td>
            <td width="25%" style="padding:4px"><div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:14px;text-align:center">
              <div style="font-size:26px;font-weight:700;color:#dc2626">${netExpired}</div>
              <div style="font-size:11px;color:#dc2626;margin-top:2px;text-transform:uppercase;letter-spacing:.5px">Expired</div>
            </div></td>
            <td width="25%" style="padding:4px"><div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:14px;text-align:center">
              <div style="font-size:26px;font-weight:700;color:#ea580c">${netUrgent}</div>
              <div style="font-size:11px;color:#ea580c;margin-top:2px;text-transform:uppercase;letter-spacing:.5px">Urgent</div>
            </div></td>
            <td width="25%" style="padding:4px"><div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:14px;text-align:center">
              <div style="font-size:26px;font-weight:700;color:#d97706">${netNear}</div>
              <div style="font-size:11px;color:#d97706;margin-top:2px;text-transform:uppercase;letter-spacing:.5px">Near Expiry</div>
            </div></td>
          </tr></table>
        </td></tr>
        <tr><td style="padding:0 32px 28px">
          <div style="font-size:14px;font-weight:600;color:#374151;margin-bottom:10px">Breakdown by Store</div>
          <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">
            <thead><tr style="background:#f9fafb">
              <th style="padding:8px 10px;font-size:11px;font-weight:600;color:#6b7280;text-align:left;text-transform:uppercase;letter-spacing:.5px">Store</th>
              <th style="padding:8px 6px;font-size:11px;font-weight:600;color:#6b7280;text-align:center;text-transform:uppercase;letter-spacing:.5px">Code</th>
              <th style="padding:8px 6px;font-size:11px;font-weight:600;color:#6b7280;text-align:center;text-transform:uppercase;letter-spacing:.5px">Total</th>
              <th style="padding:8px 6px;font-size:11px;font-weight:600;color:#dc2626;text-align:center;text-transform:uppercase;letter-spacing:.5px">Expired</th>
              <th style="padding:8px 6px;font-size:11px;font-weight:600;color:#ea580c;text-align:center;text-transform:uppercase;letter-spacing:.5px">Urgent</th>
              <th style="padding:8px 6px;font-size:11px;font-weight:600;color:#d97706;text-align:center;text-transform:uppercase;letter-spacing:.5px">Near</th>
              <th style="padding:8px 6px;font-size:11px;font-weight:600;color:#16a34a;text-align:center;text-transform:uppercase;letter-spacing:.5px">OK</th>
              <th style="padding:8px 6px;font-size:11px;font-weight:600;color:#6b7280;text-align:center;text-transform:uppercase;letter-spacing:.5px">Qty</th>
              <th style="padding:8px 6px;font-size:11px;font-weight:600;color:#7c3aed;text-align:center;text-transform:uppercase;letter-spacing:.5px">Flags</th>
            </tr></thead>
            <tbody>${tableRows}</tbody>
          </table>
        </td></tr>
        <tr><td style="padding:0 32px 24px">
          <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:14px;font-size:13px;color:#166534">
            📎 Full detail Excel report attached — one sheet per store with every scan row, sorted by status (Expired → Urgent → Near Expiry → OK).
          </div>
        </td></tr>
        <tr><td style="background:#f9fafb;padding:16px 32px;border-top:1px solid #e5e7eb">
          <div style="font-size:11px;color:#9ca3af;text-align:center">
            Generated by Expiry Tracker · ${new Date().toLocaleDateString("en-FJ", { timeZone: "Pacific/Fiji", weekday: "long", year: "numeric", month: "long", day: "numeric" })}
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  // Generate Excel
  const excelBuffer = await buildWeeklyExcel(scansByStore, sinceStr, weekEnd);
  const filename = `Expiry_Report_${sinceStr}_to_${weekEnd}.xlsx`;

  await transporter.sendMail({
    from: `"Expiry Tracker" <${smtpUser}>`,
    to: managementEmail,
    subject: `Weekly Expiry Report — All Stores — ${sinceStr} to ${weekEnd}`,
    html,
    attachments: [{ filename, content: excelBuffer, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }],
  });

  res.json({ ok: true, sentTo: managementEmail, stores: [...scansByStore.keys()], filename });
});

router.get("/email/test-report", async (req, res): Promise<void> => {
  const adminPw = req.headers["x-admin-password"];
  if (adminPw !== process.env.ADMIN_PASSWORD) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const toEmail = String(req.query.to ?? "");
  if (!toEmail || !toEmail.includes("@")) {
    res.status(400).json({ error: "?to=email is required" });
    return;
  }

  const transporter = createTransporter();
  const smtpUser = process.env.SMTP_USER ?? process.env.GMAIL_USER;
  if (!transporter || !smtpUser) {
    res.status(503).json({ error: "Email credentials not configured on server." });
    return;
  }

  await ensureStoresSeeded();
  const allStores = await db.select().from(storesTable);

  const today = new Date();
  const weekStart = new Date(today); weekStart.setDate(today.getDate() - 7);
  const weekStartStr = weekStart.toISOString().split("T")[0]!;
  const weekEndStr = today.toISOString().split("T")[0]!;

  // Build one consolidated email with all stores as a summary table
  type StoreRow = { code: string; name: string; region: string; total: number; expired: number; urgent: number; nearExpiry: number; ok: number; totalQty: number; compliance: number };
  const rows: StoreRow[] = allStores.map(store => {
    const expired    = 2 + Math.floor(Math.random() * 6);
    const urgent     = 3 + Math.floor(Math.random() * 10);
    const nearExpiry = 5 + Math.floor(Math.random() * 15);
    const ok         = 20 + Math.floor(Math.random() * 40);
    const total      = expired + urgent + nearExpiry + ok;
    const totalQty   = total * (3 + Math.floor(Math.random() * 5));
    return { code: store.code, name: store.name, region: store.region ?? "", total, expired, urgent, nearExpiry, ok, totalQty, compliance: Math.floor(Math.random() * 8) };
  });

  const tableRows = rows.map(r => `
    <tr style="border-bottom:1px solid #f0f0f0">
      <td style="padding:7px 10px;font-size:13px;font-weight:600;color:#111827">${r.name}</td>
      <td style="padding:7px 10px;font-size:12px;color:#6b7280;text-align:center">${r.code}</td>
      <td style="padding:7px 10px;font-size:13px;text-align:center;color:#111827;font-weight:600">${r.total}</td>
      <td style="padding:7px 10px;font-size:13px;text-align:center;color:#dc2626;font-weight:700">${r.expired}</td>
      <td style="padding:7px 10px;font-size:13px;text-align:center;color:#ea580c;font-weight:700">${r.urgent}</td>
      <td style="padding:7px 10px;font-size:13px;text-align:center;color:#d97706">${r.nearExpiry}</td>
      <td style="padding:7px 10px;font-size:13px;text-align:center;color:#16a34a">${r.ok}</td>
      <td style="padding:7px 10px;font-size:12px;text-align:center;color:#6b7280">${r.totalQty}</td>
      <td style="padding:7px 10px;font-size:12px;text-align:center;color:#7c3aed">${r.compliance}</td>
    </tr>`).join("");

  const totalAll = rows.reduce((s, r) => s + r.total, 0);
  const expiredAll = rows.reduce((s, r) => s + r.expired, 0);
  const urgentAll = rows.reduce((s, r) => s + r.urgent, 0);
  const nearAll = rows.reduce((s, r) => s + r.nearExpiry, 0);

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Inter,Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 0">
    <tr><td align="center">
      <table width="700" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
        <tr><td style="background:#111827;padding:28px 32px">
          <div style="color:#f59e0b;font-size:18px;font-weight:700">⏱ Expiry Tracker</div>
          <div style="color:#ffffff;font-size:22px;font-weight:700;margin-top:4px">All-Stores Weekly Report</div>
          <div style="color:#9ca3af;font-size:13px;margin-top:2px">${weekStartStr} – ${weekEndStr} &nbsp;·&nbsp; ${rows.length} stores &nbsp;·&nbsp; [TEST]</div>
        </td></tr>
        <!-- Network totals -->
        <tr><td style="padding:24px 32px 16px">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td width="25%" style="padding:4px">
                <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:14px;text-align:center">
                  <div style="font-size:26px;font-weight:700;color:#111827">${totalAll}</div>
                  <div style="font-size:11px;color:#6b7280;margin-top:2px;text-transform:uppercase;letter-spacing:.5px">Network Scans</div>
                </div>
              </td>
              <td width="25%" style="padding:4px">
                <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:14px;text-align:center">
                  <div style="font-size:26px;font-weight:700;color:#dc2626">${expiredAll}</div>
                  <div style="font-size:11px;color:#dc2626;margin-top:2px;text-transform:uppercase;letter-spacing:.5px">Total Expired</div>
                </div>
              </td>
              <td width="25%" style="padding:4px">
                <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:14px;text-align:center">
                  <div style="font-size:26px;font-weight:700;color:#ea580c">${urgentAll}</div>
                  <div style="font-size:11px;color:#ea580c;margin-top:2px;text-transform:uppercase;letter-spacing:.5px">Total Urgent</div>
                </div>
              </td>
              <td width="25%" style="padding:4px">
                <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:14px;text-align:center">
                  <div style="font-size:26px;font-weight:700;color:#d97706">${nearAll}</div>
                  <div style="font-size:11px;color:#d97706;margin-top:2px;text-transform:uppercase;letter-spacing:.5px">Near Expiry</div>
                </div>
              </td>
            </tr>
          </table>
        </td></tr>
        <!-- Per-store table -->
        <tr><td style="padding:0 32px 28px">
          <div style="font-size:14px;font-weight:600;color:#374151;margin-bottom:10px">Breakdown by Store</div>
          <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">
            <thead>
              <tr style="background:#f9fafb">
                <th style="padding:8px 10px;font-size:11px;font-weight:600;color:#6b7280;text-align:left;text-transform:uppercase;letter-spacing:.5px">Store</th>
                <th style="padding:8px 10px;font-size:11px;font-weight:600;color:#6b7280;text-align:center;text-transform:uppercase;letter-spacing:.5px">Code</th>
                <th style="padding:8px 10px;font-size:11px;font-weight:600;color:#6b7280;text-align:center;text-transform:uppercase;letter-spacing:.5px">Total</th>
                <th style="padding:8px 10px;font-size:11px;font-weight:600;color:#dc2626;text-align:center;text-transform:uppercase;letter-spacing:.5px">Expired</th>
                <th style="padding:8px 10px;font-size:11px;font-weight:600;color:#ea580c;text-align:center;text-transform:uppercase;letter-spacing:.5px">Urgent</th>
                <th style="padding:8px 10px;font-size:11px;font-weight:600;color:#d97706;text-align:center;text-transform:uppercase;letter-spacing:.5px">Near</th>
                <th style="padding:8px 10px;font-size:11px;font-weight:600;color:#16a34a;text-align:center;text-transform:uppercase;letter-spacing:.5px">OK</th>
                <th style="padding:8px 10px;font-size:11px;font-weight:600;color:#6b7280;text-align:center;text-transform:uppercase;letter-spacing:.5px">Qty</th>
                <th style="padding:8px 10px;font-size:11px;font-weight:600;color:#7c3aed;text-align:center;text-transform:uppercase;letter-spacing:.5px">Flags</th>
              </tr>
            </thead>
            <tbody>${tableRows}</tbody>
          </table>
        </td></tr>
        <tr><td style="background:#f9fafb;padding:16px 32px;border-top:1px solid #e5e7eb">
          <div style="font-size:11px;color:#9ca3af;text-align:center">
            Generated by Expiry Tracker · ${new Date().toLocaleDateString("en-FJ", { timeZone: "Pacific/Fiji", weekday: "long", year: "numeric", month: "long", day: "numeric" })} · This is a test report with sample data
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  // Build sample Excel — generate fake scan rows for each store
  const sampleScanStatuses = ["Expired", "Expired", "Urgent", "Urgent", "Urgent", "Near Expiry", "Near Expiry", "Near Expiry", "OK", "OK", "OK", "OK"];
  const sampleItems = [
    { barcode: "9300633102015", itemNumber: "12345", description: "Anchor Full Cream Milk 2L" },
    { barcode: "9415176001234", itemNumber: "23456", description: "Meadow Fresh Yoghurt 500g" },
    { barcode: "9310055012345", itemNumber: "34567", description: "Mainland Cheddar Slices 500g" },
    { barcode: "9300652830017", itemNumber: "45678", description: "Sanitarium Weet-Bix 750g" },
    { barcode: "9415176005432", itemNumber: "56789", description: "Tip Top Bread White 700g" },
    { barcode: "9415176009876", itemNumber: "67890", description: "Pams Butter 500g" },
    { barcode: "9300633201234", itemNumber: "78901", description: "Lewis Road Creamery Milk 1L" },
    { barcode: "9310055098765", itemNumber: "89012", description: "Puhoi Valley Cheese 200g" },
  ];

  const scansByStore = new Map<string, { storeCode: string; storeName: string; scans: any[] }>();
  for (const row of rows) {
    const scans = sampleScanStatuses.map((status, i) => {
      const item = sampleItems[i % sampleItems.length]!;
      const daysLeft = status === "Expired" ? -2 : status === "Urgent" ? 3 : status === "Near Expiry" ? 10 : 25;
      const expiry = new Date(); expiry.setDate(expiry.getDate() + daysLeft);
      return {
        barcode: item.barcode, itemNumber: item.itemNumber, description: item.description,
        qty: 1 + Math.floor(Math.random() * 5),
        expiryDate: expiry.toISOString().split("T")[0],
        scanDate: weekEndStr,
        daysLeft,
        status,
        actionRequired: status === "Expired" ? "Remove from shelf" : status === "Urgent" ? "Markdown/clear" : "",
        wrongRrp: Math.random() > 0.85,
        missingSpecialTicket: Math.random() > 0.9,
        notOnDisplay: false,
        region: row.region,
      };
    });
    scansByStore.set(row.code, { storeCode: row.code, storeName: row.name, scans });
  }

  const excelBuffer = await buildWeeklyExcel(scansByStore, weekStartStr, weekEndStr);
  const filename = `TEST_Expiry_Report_${weekStartStr}_to_${weekEndStr}.xlsx`;

  await transporter.sendMail({
    from: `"Expiry Tracker" <${smtpUser}>`,
    to: toEmail,
    subject: `[TEST] All-Stores Weekly Expiry Report — ${weekStartStr} to ${weekEndStr}`,
    html,
    attachments: [{ filename, content: excelBuffer, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }],
  });

  res.json({ ok: true, sentTo: toEmail, stores: rows.map(r => r.code), filename });
});

export default router;
