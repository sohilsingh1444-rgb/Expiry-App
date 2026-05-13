import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db, expiryScansTable } from "@workspace/db";
import {
  CreateExpiryScanBody,
  DeleteExpiryScanParams,
  GetExpirySessionSummaryParams,
  GetExpirySessionSummaryResponse,
  GetLatestExpirySessionQueryParams,
  GetLatestExpirySessionResponse,
  ListExpiryScansResponseItem,
  ListExpiryScansParams,
  ListExpiryScansResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

type ExpiryStatus = "Expired" | "Urgent" | "Near Expiry" | "OK";
type ExpiryScanRow = typeof expiryScansTable.$inferSelect;

function toDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function dateOnlyToUtc(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function calculateStatus(expiryDate: Date, todayDate: Date): {
  daysLeft: number;
  status: ExpiryStatus;
  actionRequired: string | null;
} {
  const msPerDay = 24 * 60 * 60 * 1000;
  const daysLeft = Math.round((expiryDate.getTime() - todayDate.getTime()) / msPerDay);

  if (daysLeft < 0) {
    return { daysLeft, status: "Expired", actionRequired: "Remove from shelf" };
  }

  if (daysLeft <= 2) {
    return {
      daysLeft,
      status: "Urgent",
      actionRequired: "Immediate review / markdown",
    };
  }

  if (daysLeft <= 15) {
    return { daysLeft, status: "Near Expiry", actionRequired: "Monitor / markdown" };
  }

  return { daysLeft, status: "OK", actionRequired: null };
}

function withCurrentExpiryStatus(row: ExpiryScanRow): ExpiryScanRow {
  const status = calculateStatus(
    dateOnlyToUtc(row.expiryDate),
    dateOnlyToUtc(toDateOnly(new Date())),
  );

  return {
    ...row,
    daysLeft: status.daysLeft,
    status: status.status,
    actionRequired: status.actionRequired,
  };
}

router.get("/expiry-sessions/latest", async (req, res): Promise<void> => {
  const query = {
    ...req.query,
    scanDate:
      typeof req.query.scanDate === "string"
        ? dateOnlyToUtc(req.query.scanDate)
        : req.query.scanDate,
  };
  const parsed = GetLatestExpirySessionQueryParams.safeParse(query);

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const scanDate = toDateOnly(parsed.data.scanDate);
  const [latest] = await db
    .select({ sessionId: expiryScansTable.sessionId })
    .from(expiryScansTable)
    .where(
      and(
        eq(expiryScansTable.pdUserName, parsed.data.pdUserName),
        eq(expiryScansTable.storeLocation, parsed.data.storeLocation),
        eq(expiryScansTable.scanDate, scanDate),
      ),
    )
    .orderBy(desc(expiryScansTable.createdAt))
    .limit(1);

  res.json(GetLatestExpirySessionResponse.parse({ sessionId: latest?.sessionId ?? null }));
});

router.get("/expiry-sessions/:sessionId/scans", async (req, res): Promise<void> => {
  const params = ListExpiryScansParams.safeParse(req.params);

  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const rows = await db
    .select()
    .from(expiryScansTable)
    .where(eq(expiryScansTable.sessionId, params.data.sessionId))
    .orderBy(expiryScansTable.createdAt);

  res.json(ListExpiryScansResponse.parse(rows.map(withCurrentExpiryStatus)));
});

router.get("/expiry-sessions/:sessionId/summary", async (req, res): Promise<void> => {
  const params = GetExpirySessionSummaryParams.safeParse(req.params);

  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const rows = await db
    .select()
    .from(expiryScansTable)
    .where(eq(expiryScansTable.sessionId, params.data.sessionId));

  const today = dateOnlyToUtc(toDateOnly(new Date()));
  const summary = rows.map(withCurrentExpiryStatus).reduce(
    (acc, row) => {
      const expiry = dateOnlyToUtc(row.expiryDate);
      acc.scans += 1;
      acc.totalQty += row.qty;

      if (expiry.getTime() < today.getTime()) {
        acc.expiredItems += 1;
      } else {
        acc.activeItems += 1;
      }

      if (row.status === "Urgent") {
        acc.urgentItems += 1;
      }

      if (row.status === "Near Expiry") {
        acc.nearExpiryItems += 1;
      }

      return acc;
    },
    {
      scans: 0,
      activeItems: 0,
      expiredItems: 0,
      totalQty: 0,
      urgentItems: 0,
      nearExpiryItems: 0,
    },
  );

  res.json(GetExpirySessionSummaryResponse.parse(summary));
});

router.post("/expiry-scans", async (req, res, next): Promise<void> => {
  try {
    const parsed = CreateExpiryScanBody.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const body = parsed.data;
    const today = dateOnlyToUtc(toDateOnly(new Date()));
    const expiryDate = body.expiryDate
      ? dateOnlyToUtc(toDateOnly(body.expiryDate))
      : dateOnlyToUtc(toDateOnly(body.scanDate));
    const scanDate = dateOnlyToUtc(toDateOnly(body.scanDate));
    const status = calculateStatus(expiryDate, today);

    const [row] = await db
      .insert(expiryScansTable)
      .values({
        sessionId: body.sessionId,
        pdUserName: body.pdUserName,
        storeLocation: body.storeLocation,
        barcode: body.barcode,
        itemNumber: body.itemNumber ?? null,
        description: body.description ?? null,
        qty: body.qty ?? 1,
        rrp: body.rrp ?? null,
        specialPrice: body.specialPrice ?? null,
        systemSoh: body.systemSoh ?? null,
        wrongRrp: body.wrongRrp ?? false,
        missingSpecialTicket: body.missingSpecialTicket ?? false,
        notOnDisplay: body.notOnDisplay ?? false,
        bulkPullQty: body.bulkPullQty ?? null,
        expiryDate: body.expiryDate ? toDateOnly(expiryDate) : toDateOnly(scanDate),
        status: status.status,
        daysLeft: status.daysLeft,
        scanDate: toDateOnly(scanDate),
        actionRequired: status.actionRequired,
        remarks: body.remarks ?? null,
      })
      .returning();

    res.status(201).json(ListExpiryScansResponseItem.parse(row));
  } catch (err) {
    next(err);
  }
});

router.delete("/expiry-sessions/:sessionId", async (req, res): Promise<void> => {
  const { sessionId } = req.params;
  if (!sessionId) {
    res.status(400).json({ error: "sessionId is required" });
    return;
  }

  const deleted = await db
    .delete(expiryScansTable)
    .where(eq(expiryScansTable.sessionId, sessionId))
    .returning({ id: expiryScansTable.id });

  res.json({ deleted: deleted.length });
});

router.delete("/expiry-scans/:id", async (req, res): Promise<void> => {
  const params = DeleteExpiryScanParams.safeParse(req.params);

  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [row] = await db
    .delete(expiryScansTable)
    .where(eq(expiryScansTable.id, params.data.id))
    .returning();

  if (!row) {
    res.status(404).json({ error: "Scan not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
