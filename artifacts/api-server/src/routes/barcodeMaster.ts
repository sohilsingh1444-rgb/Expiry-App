import { Router, type IRouter } from "express";
import { ImapFlow } from "imapflow";

const router: IRouter = Router();

const BARCODE_EMAIL_SUBJECT = "Updated Barcode Master - Expiry";

router.get("/barcode-master/from-email", async (req, res): Promise<void> => {
  const gmailUser = process.env.GMAIL_USER;
  const gmailPass = process.env.GMAIL_APP_PASSWORD;

  if (!gmailUser || !gmailPass) {
    res.status(503).json({ error: "Email credentials not configured." });
    return;
  }

  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: {
      user: gmailUser,
      pass: gmailPass,
    },
    tls: {
      // Replit sandbox lacks system CA certs; Vercel production has them
      rejectUnauthorized: process.env.NODE_ENV === "production",
    },
    logger: false,
  });

  try {
    await client.connect();

    await client.mailboxOpen("INBOX");

    // Search for latest email with the barcode master subject
    const messages = await client.search({
      subject: BARCODE_EMAIL_SUBJECT,
    });

    if (!messages || messages.length === 0) {
      await client.logout();
      res.status(404).json({
        error: `No email found with subject "${BARCODE_EMAIL_SUBJECT}". Send the barcode master Excel to ${gmailUser} with that exact subject line.`,
      });
      return;
    }

    // Get the most recent match (last in array)
    const latestUid = messages[messages.length - 1];

    // Fetch the message with attachments
    let excelBase64: string | null = null;
    let filename: string | null = null;
    let receivedDate: string | null = null;

    for await (const msg of client.fetch([latestUid], {
      envelope: true,
      bodyStructure: true,
      source: true,
    })) {
      receivedDate = msg.envelope?.date?.toISOString() ?? null;

      // Parse raw source to find Excel attachment
      const source = msg.source.toString("binary");

      // Extract MIME parts looking for Excel attachments
      const xlsxMatch = source.match(
        /Content-Disposition:\s*attachment[^]*?filename[^]*?"?([^"\r\n]+\.(xlsx|xls))"?[^]*?(?:\r\n\r\n|\n\n)([A-Za-z0-9+/=\r\n]+)/i
      );

      if (xlsxMatch) {
        filename = xlsxMatch[1].trim();
        excelBase64 = xlsxMatch[3].replace(/[\r\n]/g, "");
      } else {
        // Try alternative MIME parsing — base64 block after Content-Type spreadsheet
        const spreadsheetMatch = source.match(
          /Content-Type:\s*application\/(?:vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|vnd\.ms-excel)[^]*?(?:\r\n\r\n|\n\n)((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?(?:\r?\n[A-Za-z0-9+/\r\n=]+)*)/i
        );
        if (spreadsheetMatch) {
          excelBase64 = spreadsheetMatch[1].replace(/[\r\n]/g, "");
          filename = "barcode_master.xlsx";
        }
      }
    }

    await client.logout();

    if (!excelBase64) {
      res.status(422).json({
        error: "Email found but no Excel attachment detected. Make sure the barcode master is attached as an .xlsx file.",
      });
      return;
    }

    res.json({
      filename: filename ?? "barcode_master.xlsx",
      fileBase64: excelBase64,
      receivedDate,
      subject: BARCODE_EMAIL_SUBJECT,
    });
  } catch (err: unknown) {
    try { await client.logout(); } catch {}
    req.log.error({ err }, "IMAP error");

    const imapErr = err as Record<string, unknown>;
    if (imapErr?.authenticationFailed) {
      res.status(401).json({
        error:
          "Gmail authentication failed. Please check: 1) IMAP is enabled on the Gmail account (Settings → See all settings → Forwarding and POP/IMAP), 2) The App Password is correct and generated for 'Mail'.",
      });
      return;
    }

    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message || "IMAP connection failed" });
  }
});

export default router;
