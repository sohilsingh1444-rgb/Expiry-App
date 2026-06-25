import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { format, differenceInDays, parseISO } from "date-fns";
import type { BarcodeMasterRow } from "@/hooks/use-barcode-master";
import {
  useGetLatestExpirySession,
  getGetLatestExpirySessionQueryKey,
  useListExpiryScans,
  getListExpiryScansQueryKey,
  useGetExpirySessionSummary,
  getGetExpirySessionSummaryQueryKey,
  useCreateExpiryScan,
  useDeleteExpiryScan,
  deleteExpiryScan,
  ExpiryScanStatus,
} from "@workspace/api-client-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useOnlineStatus } from "@/hooks/use-online-status";
import { enqueueOfflineScan } from "@/lib/offline-queue";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";

import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { AlertCircle, CheckCircle2, FileSpreadsheet, Trash2, Upload, ScanLine, ArrowRight, Database, ChevronsUpDown, Check, Camera, Tag, Percent } from "lucide-react";
import { CameraScanner } from "@/components/camera-scanner";
import { parseBarcodeMaster, parseSohFile, parseRrpFile, buildRrpMap, parseSpecialsFile, buildSpecialsMap, exportToExcel } from "@/lib/xlsx";
import { useBarcodeMaster, buildBarcodeMaps } from "@/hooks/use-barcode-master";
import { useSohData } from "@/hooks/use-soh-data";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { getApiBase } from "@/lib/api-base";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useStoreList } from "@/hooks/use-store-list";

const setupSchema = z.object({
  pdUserName: z.string().min(1, "PD User Name is required"),
  storeLocation: z.string().min(1, "Store Location is required"),
  scanDate: z.string().min(1, "Scan Date is required"),
});

const scanSchema = z.object({
  barcode: z.string().min(1, "Barcode is required"),
  itemNumber: z.string().optional(),
  description: z.string().optional(),
  qty: z.coerce.number({ invalid_type_error: "Qty is required" }).min(0),
  expiryDate: z.string().optional(),
  remarks: z.string().optional(),
  wrongRrp: z.boolean().default(false),
  wrongRrpQty: z.coerce.number().optional(),
  missingSpecialTicket: z.boolean().default(false),
  missingSpecialQty: z.coerce.number().optional(),
  notOnDisplay: z.boolean().default(false),
  notOnDisplayQty: z.coerce.number().optional(),
}).superRefine((data, ctx) => {
  const hasComplianceFlag = data.wrongRrp || data.missingSpecialTicket || data.notOnDisplay;
  if (!hasComplianceFlag && data.qty <= 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Qty must be greater than 0",
      path: ["qty"],
    });
  }
  if (!hasComplianceFlag && !data.expiryDate) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Expiry Date is required",
      path: ["expiryDate"],
    });
  }
});

function getTodayDateKey() {
  return format(new Date(), "yyyy-MM-dd");
}

function getActionRequired(status: typeof ExpiryScanStatus[keyof typeof ExpiryScanStatus]) {
  switch (status) {
    case ExpiryScanStatus.Expired:
      return "Remove from shelf";
    case ExpiryScanStatus.Urgent:
      return "Immediate review / markdown";
    case ExpiryScanStatus.Near_Expiry:
      return "Monitor / markdown";
    default:
      return null;
  }
}

function calculateStatusAndDays(
  expiryDateStr: string,
  todayDateStr = getTodayDateKey(),
  urgentDays = 2,
  nearExpiryDays = 15,
) {
  const expiry = parseISO(expiryDateStr);
  const today = parseISO(todayDateStr);
  const days = differenceInDays(expiry, today);

  let status: typeof ExpiryScanStatus[keyof typeof ExpiryScanStatus] = ExpiryScanStatus.OK;
  if (days < 0) {
    status = ExpiryScanStatus.Expired;
  } else if (days <= urgentDays) {
    status = ExpiryScanStatus.Urgent;
  } else if (days <= nearExpiryDays) {
    status = ExpiryScanStatus.Near_Expiry;
  }
  
  return { status, daysLeft: days };
}

function formatDateOnly(value?: string | Date | null) {
  if (!value) return "";

  try {
    const date = value instanceof Date ? value : parseISO(String(value));
    return format(date, "yyyy-MM-dd");
  } catch {
    return String(value).split("T")[0];
  }
}

const API_BASE = getApiBase();

const SESSION_STORAGE_KEY = "expiry_scan_session";

function loadPersistedSession(): { setupData: { pdUserName: string; storeLocation: string; scanDate: string }; sessionId: string } | null {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.setupData?.pdUserName && parsed?.setupData?.storeLocation && parsed?.setupData?.scanDate && parsed?.sessionId) {
      return parsed;
    }
  } catch {}
  return null;
}

export default function Home() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const persisted = loadPersistedSession();

  const [isSetupComplete, setIsSetupComplete] = useState(() => !!persisted);
  const [setupData, setSetupData] = useState<{pdUserName: string, storeLocation: string, scanDate: string} | null>(() => persisted?.setupData ?? null);
  const [newSessionId, setNewSessionId] = useState<string | null>(() => persisted?.sessionId ?? null);
  const [showNonExpiredOnly, setShowNonExpiredOnly] = useState(false);
  const [todayDateKey, setTodayDateKey] = useState(getTodayDateKey);
  const [thresholds, setThresholds] = useState({ urgentDays: 2, nearExpiryDays: 15 });
  const [appName, setAppName] = useState("Expiry Tracker");
  const [matchedItem, setMatchedItem] = useState<BarcodeMasterRow | null>(null);
  const [isSendingEmail, setIsSendingEmail] = useState(false);
  const [storeComboOpen, setStoreComboOpen] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const barcodeInputRef   = useRef<HTMLInputElement>(null);
  const cameraScannedRef  = useRef(false); // true when barcode was set by camera scan

  const { masterData, isLoaded, rrpCount, specialsCount, saveMasterData, clearMasterData, saveRrpData, saveSpecialsData, lookupBarcode } = useBarcodeMaster();
  const { sohData, sohByItem, saveSohData, clearSohData, loadStoreSoh, lookupSoh } = useSohData();
  const totalSohItems = Math.max(sohData.size, sohByItem.size);
  const [storeSohMeta, setStoreSohMeta] = useState<{ count: number; uploadedAt: string | null } | null>(null);
  const { stores: storeList, getStoreByCode, getStoreRegion } = useStoreList();
  // Pass store code (e.g. "S0014") as primary identifier — matches ERP Location Code in SOH file.
  // Also include display name as fallback so partial/fuzzy matches still work.
  const storeIdentifiers: string[] = setupData?.storeLocation
    ? [
        setupData.storeLocation,
        getStoreByCode(setupData.storeLocation)?.name ?? '',
      ].filter(Boolean)
    : [];
  const storeRegion: string | undefined = setupData?.storeLocation ? getStoreRegion(setupData.storeLocation) : undefined;
  const { isOnline, pendingCount, refreshPendingCount } = useOnlineStatus();

  // Auto-load SOH from store portal whenever the selected store changes
  useEffect(() => {
    if (!setupData?.storeLocation) return;
    setStoreSohMeta(null);
    clearSohData();
    loadStoreSoh(setupData.storeLocation).then(meta => {
      if (meta.count > 0) setStoreSohMeta(meta);
    });
  }, [setupData?.storeLocation, loadStoreSoh, clearSohData]);

  const setupForm = useForm<z.infer<typeof setupSchema>>({
    resolver: zodResolver(setupSchema),
    defaultValues: {
      pdUserName: "",
      storeLocation: "",
      scanDate: format(new Date(), "yyyy-MM-dd"),
    },
  });

  const scanForm = useForm<z.infer<typeof scanSchema>>({
    resolver: zodResolver(scanSchema),
    reValidateMode: "onSubmit",
    defaultValues: {
      barcode: "",
      itemNumber: "",
      description: "",
      qty: "" as unknown as number,
      expiryDate: "",
      remarks: "",
      wrongRrp: false,
      wrongRrpQty: undefined,
      missingSpecialTicket: false,
      missingSpecialQty: undefined,
      notOnDisplay: false,
      notOnDisplayQty: undefined,
    },
  });

  const watchBarcode = scanForm.watch("barcode");
  const watchItemNumber = scanForm.watch("itemNumber");
  const watchExpiryDate = scanForm.watch("expiryDate");
  const watchWrongRrp = scanForm.watch("wrongRrp");
  const watchMissingSpecial = scanForm.watch("missingSpecialTicket");
  const watchNotOnDisplay = scanForm.watch("notOnDisplay");


  useEffect(() => {
    const refreshToday = () => {
      setTodayDateKey(getTodayDateKey());
    };

    refreshToday();
    const interval = window.setInterval(refreshToday, 60 * 1000);

    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    fetch(`${API_BASE}/api/admin/settings`)
      .then((r) => r.json())
      .then((data) => {
        if (typeof data.urgentDays === "number" && typeof data.nearExpiryDays === "number") {
          setThresholds({ urgentDays: data.urgentDays, nearExpiryDays: data.nearExpiryDays });
        }
        if (typeof data.appName === "string" && data.appName.trim()) {
          setAppName(data.appName.trim());
        }
      })
      .catch(() => {});
  }, []);

  const scanSetValue = scanForm.setValue;
  const scanGetValues = scanForm.getValues;

  useEffect(() => {
    if (watchBarcode && watchBarcode.length > 3) {
      const match = lookupBarcode(watchBarcode, storeRegion, scanGetValues("itemNumber"));
      if (match) {
        setMatchedItem(match);
        scanSetValue("itemNumber", match.itemNumber);
        scanSetValue("description", match.description);
      } else {
        setMatchedItem(null);
        scanSetValue("itemNumber", "");
        scanSetValue("description", "");
        // Show error toast when scanned from camera and master is loaded but barcode not found
        if (cameraScannedRef.current && isLoaded && masterData.length > 0) {
          toast({
            title: "Barcode not found",
            description: `"${watchBarcode}" was not found in the barcode master. Check the barcode or enter details manually.`,
            variant: "destructive",
          });
        }
      }
    } else {
      setMatchedItem(null);
      if (!watchBarcode) {
        scanSetValue("itemNumber", "");
        scanSetValue("description", "");
      }
    }
    cameraScannedRef.current = false;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchBarcode, lookupBarcode]);

  useEffect(() => {
    const ping = () => fetch(`${API_BASE}/api/healthz`, { method: "GET" }).catch(() => {});
    ping();
    const id = window.setInterval(ping, 9 * 60 * 1000);
    return () => window.clearInterval(id);
  }, []);


  const { data: latestSession, isLoading: isLoadingSession } = useGetLatestExpirySession(
    setupData || { pdUserName: "", storeLocation: "", scanDate: "" },
    {
      query: {
        enabled: !!setupData,
        queryKey: getGetLatestExpirySessionQueryKey(setupData || { pdUserName: "", storeLocation: "", scanDate: "" }),
      }
    }
  );

  const sessionId = latestSession?.sessionId ?? newSessionId;

  const { data: scans = [], isLoading: isLoadingScans } = useListExpiryScans(sessionId || "", {
    query: {
      enabled: !!sessionId,
      queryKey: getListExpiryScansQueryKey(sessionId || ""),
    }
  });

  const { data: summary } = useGetExpirySessionSummary(sessionId || "", {
    query: {
      enabled: !!sessionId,
      queryKey: getGetExpirySessionSummaryQueryKey(sessionId || ""),
    }
  });

  const createScan = useCreateExpiryScan({
    mutation: {
      onMutate: async (variables) => {
        if (!sessionId) return;
        await queryClient.cancelQueries({ queryKey: getListExpiryScansQueryKey(sessionId) });
        const previousScans = queryClient.getQueryData(getListExpiryScansQueryKey(sessionId));

        const expiryDate = new Date(String(variables.data.expiryDate));
        const scanDate = new Date(String(variables.data.scanDate));
        const msPerDay = 1000 * 60 * 60 * 24;
        const daysLeft = Math.ceil((expiryDate.getTime() - new Date().setHours(0,0,0,0)) / msPerDay);
        const status: "Expired" | "Urgent" | "Near Expiry" | "OK" =
          daysLeft <= 0 ? "Expired" : daysLeft <= 7 ? "Urgent" : daysLeft <= 30 ? "Near Expiry" : "OK";

        const optimisticScan = {
          id: -Date.now(),
          sessionId: variables.data.sessionId,
          pdUserName: variables.data.pdUserName,
          storeLocation: variables.data.storeLocation,
          barcode: variables.data.barcode,
          itemNumber: variables.data.itemNumber ?? null,
          description: variables.data.description ?? null,
          qty: variables.data.qty ?? 1,
          rrp: (variables.data as any).rrp ?? null,
          specialPrice: (variables.data as any).specialPrice ?? null,
          systemSoh: (variables.data as any).systemSoh ?? null,
          wrongRrp: (variables.data as any).wrongRrp ?? false,
          missingSpecialTicket: (variables.data as any).missingSpecialTicket ?? false,
          notOnDisplay: (variables.data as any).notOnDisplay ?? false,
          bulkPullQty: (variables.data as any).bulkPullQty ?? null,
          expiryDate,
          status,
          daysLeft,
          scanDate,
          actionRequired: null,
          remarks: variables.data.remarks ?? null,
          createdAt: new Date(),
        };

        queryClient.setQueryData(getListExpiryScansQueryKey(sessionId), (old: unknown) =>
          Array.isArray(old) ? [optimisticScan, ...old] : [optimisticScan]
        );

        scanForm.reset({ barcode: "", itemNumber: "", description: "", qty: "" as unknown as number, expiryDate: "", remarks: "", wrongRrp: false, wrongRrpQty: undefined, missingSpecialTicket: false, missingSpecialQty: undefined, notOnDisplay: false, notOnDisplayQty: undefined });
        setTimeout(() => { barcodeInputRef.current?.focus(); }, 50);
        toast({ title: "Scan saved", description: "Item recorded." });

        return { previousScans };
      },
      onError: (err, _vars, context: { previousScans?: unknown } | undefined) => {
        if (sessionId && context?.previousScans !== undefined) {
          queryClient.setQueryData(getListExpiryScansQueryKey(sessionId), context.previousScans);
        }
        const errMsg = (() => {
          if (!err) return "Scan could not be saved. Please try again.";
          if (err instanceof Error) {
            const detail = err.message.replace(/^HTTP \d+[^:]*:\s*/i, "").trim();
            return detail.slice(0, 250) || "Scan could not be saved. Please try again.";
          }
          return "Scan could not be saved. Please try again.";
        })();
        toast({ title: "Failed to save scan", description: errMsg, variant: "destructive" });
      },
      onSettled: () => {
        if (sessionId) {
          queryClient.invalidateQueries({ queryKey: getListExpiryScansQueryKey(sessionId) });
          queryClient.invalidateQueries({ queryKey: getGetExpirySessionSummaryQueryKey(sessionId) });
        }
      },
    }
  });

  const deleteScan = useDeleteExpiryScan({
    mutation: {
      onSuccess: () => {
        if (sessionId) {
          queryClient.invalidateQueries({ queryKey: getListExpiryScansQueryKey(sessionId) });
          queryClient.invalidateQueries({ queryKey: getGetExpirySessionSummaryQueryKey(sessionId) });
        }
        toast({
          title: "Scan deleted",
        });
      }
    }
  });

  const clearAllScans = useMutation({
    mutationFn: async (ids: number[]) => {
      await Promise.all(ids.map((id) => deleteExpiryScan(id)));
    },
    onSuccess: () => {
      if (sessionId) {
        queryClient.invalidateQueries({ queryKey: getListExpiryScansQueryKey(sessionId) });
        queryClient.invalidateQueries({ queryKey: getGetExpirySessionSummaryQueryKey(sessionId) });
      }
      toast({
        title: "All scans cleared",
        description: "The current session list is now empty.",
      });
    },
    onError: (err) => {
      toast({
        title: "Failed to clear scans",
        description: String(err),
        variant: "destructive",
      });
    },
  });

  const onSetupSubmit = (values: z.infer<typeof setupSchema>) => {
    const sid = `${values.storeLocation}_${values.pdUserName}_${values.scanDate}_${crypto.randomUUID().slice(0, 8)}`;
    setSetupData(values);
    setNewSessionId(sid);
    setIsSetupComplete(true);
    try { sessionStorage.setItem('expiry_setup_done', '1'); } catch {}
    try {
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ setupData: values, sessionId: sid }));
    } catch {}
  };

  const onScanSubmit = useCallback(async (values: z.infer<typeof scanSchema>) => {
    if (!sessionId) {
      toast({ title: "Session not ready", variant: "destructive" });
      return;
    }
    if (!setupData) return;

    let barcodeStr = values.barcode.trim();
    if (barcodeStr.endsWith('.0')) {
      barcodeStr = barcodeStr.slice(0, -2);
    }

    const scanPayload = {
      sessionId,
      pdUserName: setupData.pdUserName,
      storeLocation: setupData.storeLocation,
      scanDate: setupData.scanDate,
      barcode: barcodeStr,
      itemNumber: values.itemNumber,
      description: values.description,
      qty: values.qty,
      expiryDate: values.expiryDate || setupData.scanDate,
      remarks: [
        values.remarks,
        values.wrongRrp && values.wrongRrpQty != null ? `Wrong RRP Qty: ${values.wrongRrpQty}` : null,
        values.missingSpecialTicket && values.missingSpecialQty != null ? `Missing Ticket Qty: ${values.missingSpecialQty}` : null,
        values.notOnDisplay && values.notOnDisplayQty != null ? `Not On Display Qty: ${values.notOnDisplayQty}` : null,
      ].filter(Boolean).join(" | ") || undefined,
      ...(matchedItem?.rrp ? { rrp: parseFloat(String(matchedItem.rrp)) } : {}),
      ...(matchedItem?.special ? { specialPrice: parseFloat(String(matchedItem.special)) } : {}),
      ...(lookupSoh(barcodeStr, values.itemNumber, storeIdentifiers, storeRegion) != null ? { systemSoh: lookupSoh(barcodeStr, values.itemNumber, storeIdentifiers, storeRegion)! } : {}),
      wrongRrp: values.wrongRrp,
      missingSpecialTicket: values.missingSpecialTicket,
      notOnDisplay: values.notOnDisplay,
      ...(values.notOnDisplay ? { bulkPullQty: values.notOnDisplayQty ?? values.qty } : {}),
    };

    if (!isOnline) {
      // Queue locally and add optimistic entry to UI
      try { await enqueueOfflineScan(scanPayload as Record<string, unknown>); } catch {}
      try { await refreshPendingCount(); } catch {}

      const expiryDate = new Date(String(scanPayload.expiryDate));
      const msPerDay = 1000 * 60 * 60 * 24;
      const daysLeft = Math.ceil((expiryDate.getTime() - new Date().setHours(0,0,0,0)) / msPerDay);
      const status: "Expired" | "Urgent" | "Near Expiry" | "OK" =
        daysLeft <= 0 ? "Expired" : daysLeft <= 7 ? "Urgent" : daysLeft <= 30 ? "Near Expiry" : "OK";
      const optimistic = { id: -Date.now(), ...scanPayload, expiryDate, scanDate: new Date(scanPayload.scanDate), daysLeft, status, actionRequired: null, createdAt: new Date(), specialPrice: null, systemSoh: null, rrp: null, bulkPullQty: null, wrongRrp: false, missingSpecialTicket: false, notOnDisplay: false, itemNumber: scanPayload.itemNumber ?? null, description: scanPayload.description ?? null, remarks: scanPayload.remarks ?? null };
      queryClient.setQueryData(getListExpiryScansQueryKey(sessionId), (old: unknown) =>
        Array.isArray(old) ? [optimistic, ...old] : [optimistic]
      );

      scanForm.reset({ barcode: "", itemNumber: "", description: "", qty: "" as unknown as number, expiryDate: "", remarks: "", wrongRrp: false, wrongRrpQty: undefined, missingSpecialTicket: false, missingSpecialQty: undefined, notOnDisplay: false, notOnDisplayQty: undefined });
      setTimeout(() => { barcodeInputRef.current?.focus(); }, 50);
      toast({ title: "Saved offline", description: "Will sync when connection is restored." });
      return;
    }

    createScan.mutate({ data: scanPayload as any });
  }, [sessionId, setupData, isOnline, matchedItem, lookupSoh, enqueueOfflineScan, refreshPendingCount, queryClient, scanForm, barcodeInputRef, toast, createScan]);

  async function gzipBase64Home(obj: unknown): Promise<string> {
    const jsonBytes = new TextEncoder().encode(JSON.stringify(obj));
    const cs = new CompressionStream("gzip");
    const writer = cs.writable.getWriter();
    writer.write(jsonBytes);
    writer.close();
    const chunks: Uint8Array[] = [];
    const reader = cs.readable.getReader();
    while (true) { const { done, value } = await reader.read(); if (done) break; chunks.push(value as Uint8Array); }
    const all = new Uint8Array(chunks.reduce((acc, c) => acc + c.length, 0));
    let off = 0;
    for (const c of chunks) { all.set(c, off); off += c.length; }
    // Chunked btoa to avoid stack overflow on large files
    let binary = "";
    const chunk = 65536;
    for (let i = 0; i < all.length; i += chunk) {
      binary += String.fromCharCode(...all.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const data = await parseBarcodeMaster(file);
      if (!data.length) {
        toast({ title: "Empty file", description: "No rows found in the file.", variant: "destructive" });
        e.target.value = "";
        return;
      }
      const { map, count } = buildBarcodeMaps(data);
      if (Object.keys(map).length === 0) {
        toast({ title: "No barcodes found", description: "Could not detect a barcode column. Check the file format.", variant: "destructive" });
        e.target.value = "";
        return;
      }
      saveMasterData(data);
      toast({ title: "Master Data Uploaded", description: `Loaded ${count.toLocaleString()} items.` });
      // Persist to server in the background so it auto-loads on next open
      gzipBase64Home({ map, count }).then(compressed =>
        fetch(`${API_BASE}/api/barcode-master`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ compressed }),
        })
      ).catch(() => {});
    } catch {
      toast({ title: "Upload Failed", description: "Failed to parse the Excel file.", variant: "destructive" });
    }
    e.target.value = "";
  };

  const handleSohFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const data = await parseSohFile(file);
      saveSohData(data);
      toast({ title: "SOH Data Uploaded", description: `Loaded ${data.length} items from SOH file.` });
    } catch {
      toast({ title: "Upload Failed", description: "Failed to parse the SOH file.", variant: "destructive" });
    }
    e.target.value = "";
  };

  const handleRrpFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const rows = await parseRrpFile(file);
      const { byItem, count } = buildRrpMap(rows);
      if (count === 0) {
        toast({ title: "No RRP data found", description: "Check that the file has Sales Code (CR/NR/WR), Item No., and price columns.", variant: "destructive" });
      } else {
        saveRrpData(byItem);
        fetch(`${API_BASE}/api/rrp-data`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ byItem, count }),
        }).catch(() => {});
        toast({ title: "RRP Data Uploaded", description: `Merged ${count.toLocaleString()} items into barcode lookup.` });
      }
    } catch {
      toast({ title: "Upload Failed", description: "Failed to parse the RRP file.", variant: "destructive" });
    }
    e.target.value = "";
  };

  const handleSpecialsFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const rows = await parseSpecialsFile(file);
      const { byItem, rrpByItem, count } = buildSpecialsMap(rows);
      const specialsItems = Object.keys(byItem).length;
      const rrpItems = Object.keys(rrpByItem).length;
      if (count === 0) {
        toast({ title: "No data matched", description: `Found ${rows.length} rows but could not read any deal prices. Make sure this is the Specials/Offers export with a Price Group or OfferDescription column showing NR, CR, or WR.`, variant: "destructive" });
      } else {
        if (specialsItems > 0) saveSpecialsData(byItem);
        if (rrpItems > 0) saveRrpData(rrpByItem);
        if (specialsItems > 0) {
          fetch(`${API_BASE}/api/specials-data`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ byItem, count: specialsItems }),
          }).catch(() => {});
        }
        if (rrpItems > 0) {
          fetch(`${API_BASE}/api/rrp-data`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ byItem: rrpByItem, count: rrpItems }),
          }).catch(() => {});
        }
        const parts = [];
        if (specialsItems > 0) parts.push(`${specialsItems.toLocaleString()} deal prices`);
        if (rrpItems > 0) parts.push(`${rrpItems.toLocaleString()} RRP prices`);
        toast({ title: "Specials Data Uploaded", description: `Loaded ${parts.join(' and ')}.` });
      }
    } catch {
      toast({ title: "Upload Failed", description: "Failed to parse the Specials file.", variant: "destructive" });
    }
    e.target.value = "";
  };

  const scansWithCurrentDays = useMemo(() => {
    const items = Array.isArray(scans) ? scans : [];
    return items.map((scan) => {
      const current = calculateStatusAndDays(formatDateOnly(scan.expiryDate), todayDateKey, thresholds.urgentDays, thresholds.nearExpiryDays);

      return {
        ...scan,
        status: current.status,
        daysLeft: current.daysLeft,
        actionRequired: getActionRequired(current.status),
      };
    });
  }, [scans, todayDateKey, thresholds]);

  const liveSummary = useMemo(() => {
    return scansWithCurrentDays.reduce(
      (acc, scan) => {
        acc.scans += 1;
        acc.totalQty += scan.qty;

        if (scan.status === ExpiryScanStatus.Expired) {
          acc.expiredItems += 1;
        } else {
          acc.activeItems += 1;
        }

        if (scan.status === ExpiryScanStatus.Urgent) {
          acc.urgentItems += 1;
        }

        if (scan.status === ExpiryScanStatus.Near_Expiry) {
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
  }, [scansWithCurrentDays]);

  const visibleScans = useMemo(() => {
    if (!showNonExpiredOnly) return scansWithCurrentDays;
    return scansWithCurrentDays.filter(s => s.status !== ExpiryScanStatus.Expired);
  }, [scansWithCurrentDays, showNonExpiredOnly]);

  const handleExport = async () => {
    if (!visibleScans.length) return;

    const exportData = scansWithCurrentDays.map(s => ({
      "PD User Name": s.pdUserName,
      "Store Location": s.storeLocation,
      "Barcode": s.barcode,
      "Item Number": s.itemNumber,
      "Description": s.description,
      "RRP": (s as any).rrp ?? null,
      "Special Price": (s as any).specialPrice ?? null,
      "System SOH": (s as any).systemSoh ?? null,
      "Bulk Pull Qty": (s as any).bulkPullQty ?? (s as any).qty ?? null,
      "Qty": s.qty,
      "Expiry Date": formatDateOnly(s.expiryDate),
      "Status": s.status,
      "Days Left": s.daysLeft,
      "Scan Date": formatDateOnly(s.scanDate),
      "Action Required": s.actionRequired,
      "Remarks": s.remarks,
      "_wrongRrp": (s as any).wrongRrp === true,
      "_missingSpecialTicket": (s as any).missingSpecialTicket === true,
      "_notOnDisplay": (s as any).notOnDisplay === true,
    }));

    const filename = `Expiry_Scans_${setupData?.storeLocation || 'Export'}_${format(new Date(), 'yyyyMMdd_HHmm')}.xlsx`;
    const fileBase64 = await exportToExcel(exportData, filename.replace(".xlsx", ""));

    // Send email to store if configured
    if (fileBase64 && setupData?.storeLocation) {
      setIsSendingEmail(true);
      try {
        const emailRes = await fetch(`${API_BASE}/api/email/send-export`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            storeLocation: setupData.storeLocation,
            pdUserName: setupData.pdUserName,
            scanDate: setupData.scanDate,
            filename,
            fileBase64,
          }),
        });
        const emailData = await emailRes.json();
        if (emailRes.ok && emailData.sent) {
          toast({
            title: "Email sent",
            description: `Report emailed to ${emailData.to.join(", ")}`,
          });
        } else if (emailRes.status === 503) {
          // Email not configured — silently skip
        } else if (emailRes.status === 404) {
          toast({
            title: "No email for this store",
            description: `No email address is set up for ${setupData.storeLocation}. Add one in the Admin panel.`,
            variant: "destructive",
          });
        }
      } catch {
        // Email failure is non-critical — download already succeeded
      } finally {
        setIsSendingEmail(false);
      }
    }

    if (sessionId) {
      try {
        await fetch(`${API_BASE}/api/expiry-sessions/${sessionId}`, { method: "DELETE" });
        queryClient.invalidateQueries({ queryKey: getListExpiryScansQueryKey(sessionId) });
        queryClient.invalidateQueries({ queryKey: getGetExpirySessionSummaryQueryKey(sessionId) });
        try { localStorage.removeItem(SESSION_STORAGE_KEY); } catch {}
        try { sessionStorage.removeItem('expiry_setup_done'); } catch {}
        toast({
          title: "Exported and cleared",
          description: "Report emailed. Session data cleared.",
        });
      } catch {
        // Silent — export already succeeded, cleanup failure is non-critical
      }
    }
  };

  const handleClearAll = () => {
    if (!scans.length || clearAllScans.isPending) return;

    const confirmed = window.confirm(
      `Clear all ${scans.length} scan${scans.length === 1 ? "" : "s"} from this session? This cannot be undone.`,
    );

    if (!confirmed) return;

    clearAllScans.mutate(scans.map((scan) => scan.id));
  };

  const getStatusColor = (status: string) => {
    switch(status) {
      case ExpiryScanStatus.Expired: return "bg-destructive text-destructive-foreground hover:bg-destructive/90";
      case ExpiryScanStatus.Urgent: return "bg-orange-500 text-white hover:bg-orange-600";
      case ExpiryScanStatus.Near_Expiry: return "bg-yellow-400 text-yellow-950 hover:bg-yellow-500";
      default: return "bg-green-500 text-white hover:bg-green-600";
    }
  };

  const currentStatusPreview = useMemo(() => {
    if (!watchExpiryDate || !setupData?.scanDate) return null;
    try {
      return calculateStatusAndDays(watchExpiryDate, todayDateKey, thresholds.urgentDays, thresholds.nearExpiryDays);
    } catch(e) {
      return null;
    }
  }, [watchExpiryDate, setupData?.scanDate, todayDateKey, thresholds]);

  if (!isSetupComplete) {
    return (
      <div className="min-h-[100dvh] bg-zinc-50 flex items-center justify-center p-4">
        <Card className="w-full max-w-md shadow-lg border-zinc-200">
          <CardHeader className="space-y-1 bg-zinc-950 text-zinc-50 rounded-t-xl pb-6">
            <div className="flex items-center gap-2 mb-2">
              <ScanLine className="w-6 h-6 text-amber-500" />
              <CardTitle className="text-2xl font-bold tracking-tight">{appName}</CardTitle>
            </div>
            <CardDescription className="text-zinc-400">
              Start a new scanning session for your location.
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-6">
            <Form {...setupForm}>
              <form onSubmit={setupForm.handleSubmit(onSetupSubmit)} className="space-y-4">
                <FormField
                  control={setupForm.control}
                  name="pdUserName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-zinc-900 font-semibold">PD User Name</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. jdoe" className="bg-white border-zinc-300" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={setupForm.control}
                  name="storeLocation"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-zinc-900 font-semibold">Store Location</FormLabel>
                      <Popover open={storeComboOpen} onOpenChange={setStoreComboOpen}>
                        <PopoverTrigger asChild>
                          <FormControl>
                            <button
                              type="button"
                              role="combobox"
                              aria-expanded={storeComboOpen}
                              className={`w-full flex items-center justify-between rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm h-10 hover:bg-zinc-50 focus:outline-none focus:ring-2 focus:ring-zinc-400 ${!field.value ? "text-zinc-400" : "text-zinc-900"}`}
                            >
                              <span className="truncate">
                                {field.value
                                  ? (() => { const s = getStoreByCode(field.value); return s ? `${s.name} — ${s.code} [${s.region}]` : field.value; })()
                                  : "Select a store…"}
                              </span>
                              <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 text-zinc-400" />
                            </button>
                          </FormControl>
                        </PopoverTrigger>
                        <PopoverContent className="p-0 w-[340px]" align="start">
                          <Command>
                            <CommandInput placeholder="Search store name or code…" className="h-9" />
                            <CommandList className="max-h-64">
                              <CommandEmpty>No store found.</CommandEmpty>
                              {(["WR", "CR", "NR"] as const).map(region => {
                                const regionLabel = region === "WR" ? "Western Region (WR)" : region === "CR" ? "Central Region (CR)" : "Northern Region (NR)";
                                return (
                                  <CommandGroup key={region} heading={regionLabel}>
                                    {storeList.filter(s => s.region === region).map(store => (
                                      <CommandItem
                                        key={store.code}
                                        value={`${store.name} ${store.code} ${store.region}`}
                                        onSelect={() => { field.onChange(store.code); setStoreComboOpen(false); }}
                                        className="flex items-center justify-between"
                                      >
                                        <span>{store.name} <span className="text-xs text-zinc-400 font-mono ml-1">{store.code}</span></span>
                                        {field.value === store.code && <Check className="h-4 w-4 text-zinc-700" />}
                                      </CommandItem>
                                    ))}
                                  </CommandGroup>
                                );
                              })}
                            </CommandList>
                          </Command>
                        </PopoverContent>
                      </Popover>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={setupForm.control}
                  name="scanDate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-zinc-900 font-semibold">Scan Date</FormLabel>
                      <FormControl>
                        <Input type="date" className="bg-white border-zinc-300" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <Button type="submit" className="w-full mt-6 bg-amber-500 hover:bg-amber-600 text-white font-bold h-12 text-lg">
                  Start Session <ArrowRight className="ml-2 w-5 h-5" />
                </Button>
              </form>
            </Form>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] bg-zinc-50 pb-20">
      {/* Header Bar */}
      <header className="bg-zinc-950 text-zinc-50 py-3 px-4 md:px-6 sticky top-0 z-10 shadow-md">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ScanLine className="w-5 h-5 text-amber-500" />
            <h1 className="text-xl font-bold tracking-tight hidden sm:block">{appName}</h1>
          </div>
          <div className="flex items-center gap-4 text-sm font-medium text-zinc-300">
            <div className="flex items-center gap-1.5 bg-zinc-900 px-3 py-1.5 rounded-md border border-zinc-800">
              <span className="text-zinc-500">Loc:</span>
              <span className="text-amber-500">{setupData?.storeLocation ? (getStoreByCode(setupData.storeLocation)?.name ?? setupData.storeLocation) : ''}</span>
              {setupData?.storeLocation && getStoreRegion(setupData.storeLocation) && (
                <span className="text-xs text-zinc-400 bg-zinc-800 px-1.5 py-0.5 rounded font-mono">{getStoreRegion(setupData.storeLocation)}</span>
              )}
            </div>
            <div className="flex items-center gap-1.5 bg-zinc-900 px-3 py-1.5 rounded-md border border-zinc-800">
              <span className="text-zinc-500">User:</span> <span className="text-amber-500">{setupData?.pdUserName}</span>
            </div>
            <Button variant="ghost" size="sm" className="text-zinc-400 hover:text-white" onClick={() => { setIsSetupComplete(false); try { sessionStorage.removeItem('expiry_setup_done'); } catch {} }}>
              Change
            </Button>
            <a href="/admin" className="text-zinc-500 hover:text-zinc-300 text-xs transition-colors">
              Admin
            </a>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-4 md:p-6 grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-6">
        
        {/* LEFT COLUMN: Input & Upload */}
        <div className="space-y-6">
          <Card className="border-zinc-200 shadow-sm">
            <CardHeader className="pb-4 border-b border-zinc-100 bg-white rounded-t-xl">
              <CardTitle className="text-lg flex items-center gap-2">
                <ScanLine className="w-5 h-5" />
                Scan Item
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-6 bg-white rounded-b-xl">
              <Form {...scanForm}>
                <form onSubmit={scanForm.handleSubmit(onScanSubmit)} className="space-y-4">
                  <FormField
                    control={scanForm.control}
                    name="barcode"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="font-bold text-zinc-800">Barcode / UPC</FormLabel>
                        <FormControl>
                          <div className="flex gap-2">
                            <Input 
                              {...field} 
                              placeholder="Scan or type..." 
                              className="h-12 text-lg font-mono bg-zinc-50 border-zinc-300 focus-visible:ring-amber-500"
                              autoFocus
                              ref={(e) => {
                                field.ref(e);
                                if (e) {
                                  // @ts-ignore
                                  barcodeInputRef.current = e;
                                }
                              }}
                            />
                            <Button
                              type="button"
                              variant="outline"
                              size="icon"
                              className="h-12 w-12 shrink-0 border-zinc-300 hover:bg-amber-50 hover:border-amber-400"
                              onClick={() => setCameraOpen(true)}
                              title="Scan with camera"
                            >
                              <Camera className="w-5 h-5 text-zinc-600" />
                            </Button>
                          </div>
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  
                  {/* Matched item info panel */}
                  {matchedItem && (matchedItem.rrp || matchedItem.special || matchedItem.soh || totalSohItems > 0) && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 space-y-1.5 text-sm">
                      <div className="text-xs font-semibold text-amber-700 uppercase tracking-wide mb-1">Item Data</div>
                      {/* RRP row: Each / Case of 6 / Case of 12 — special shown inline, no dates */}
                      {(matchedItem?.rrp || matchedItem?.rrp_6 || matchedItem?.rrp_12) && (
                        <div className="grid grid-cols-3 gap-1.5 text-center">
                          <div className={`bg-white rounded-md border px-1.5 py-1.5 ${matchedItem?.special ? 'border-green-200' : 'border-amber-100'}`}>
                            <div className="text-xs text-zinc-500">RRP (Each)</div>
                            <div className="font-bold text-zinc-900">{matchedItem?.rrp ? `$${matchedItem.rrp}` : '—'}</div>
                            {matchedItem?.special && (
                              <div className="text-xs font-semibold text-green-600 mt-0.5">Special ${matchedItem.special}</div>
                            )}
                          </div>
                          <div className={`bg-white rounded-md border px-1.5 py-1.5 ${matchedItem?.rrp_6_special ? 'border-green-200' : 'border-amber-100'}`}>
                            <div className="text-xs text-zinc-500">Case of 6</div>
                            <div className="font-bold text-zinc-900">{matchedItem?.rrp_6 ? `$${matchedItem.rrp_6}` : '—'}</div>
                            {(matchedItem as any)?.rrp_6_special && (
                              <div className="text-xs font-semibold text-green-600 mt-0.5">Special ${(matchedItem as any).rrp_6_special}</div>
                            )}
                          </div>
                          <div className={`bg-white rounded-md border px-1.5 py-1.5 ${(matchedItem as any)?.rrp_12_special ? 'border-green-200' : 'border-amber-100'}`}>
                            <div className="text-xs text-zinc-500">Case of 12</div>
                            <div className="font-bold text-zinc-900">{matchedItem?.rrp_12 ? `$${matchedItem.rrp_12}` : '—'}</div>
                            {(matchedItem as any)?.rrp_12_special && (
                              <div className="text-xs font-semibold text-green-600 mt-0.5">Special ${(matchedItem as any).rrp_12_special}</div>
                            )}
                          </div>
                        </div>
                      )}
                      <div className="grid grid-cols-2 gap-2 text-center">
                        {matchedItem?.soh && (
                          <div className="bg-white rounded-md border border-blue-100 px-2 py-1.5">
                            <div className="text-xs text-zinc-500">Store SOH</div>
                            <div className="font-bold text-blue-700">{matchedItem.soh}</div>
                          </div>
                        )}
                        {totalSohItems > 0 && (
                          <div className={`bg-white rounded-md border px-2 py-1.5 ${lookupSoh(watchBarcode, watchItemNumber, storeIdentifiers, storeRegion) != null ? 'border-purple-100' : 'border-zinc-100'}`}>
                            <div className="text-xs text-zinc-500">System SOH</div>
                            {lookupSoh(watchBarcode, watchItemNumber, storeIdentifiers, storeRegion) != null
                              ? <div className="font-bold text-purple-700">{lookupSoh(watchBarcode, watchItemNumber, storeIdentifiers, storeRegion)}</div>
                              : <div className="font-bold text-zinc-400">—</div>
                            }
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-4">
                    <FormField
                      control={scanForm.control}
                      name="itemNumber"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-zinc-700">Item No.</FormLabel>
                          <FormControl>
                            <Input {...field} className="bg-zinc-50 border-zinc-200" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={scanForm.control}
                      name="qty"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-zinc-700">Qty</FormLabel>
                          <FormControl>
                            <Input type="number" step="0.01" min="0.01" placeholder="" {...field} value={field.value === 0 ? "" : field.value} className="bg-zinc-50 border-zinc-200 font-mono" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>

                  <FormField
                    control={scanForm.control}
                    name="description"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-zinc-700">Description</FormLabel>
                        <FormControl>
                          <Input {...field} className="bg-zinc-50 border-zinc-200" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={scanForm.control}
                    name="expiryDate"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="font-bold text-zinc-800">Expiry Date</FormLabel>
                        <FormControl>
                          <Input type="date" {...field} className="h-12 bg-zinc-50 border-zinc-300 focus-visible:ring-amber-500" />
                        </FormControl>
                        <FormMessage />
                        {currentStatusPreview && (
                          <div className="mt-2 text-sm flex items-center gap-2">
                            <span className="text-zinc-500">Preview:</span>
                            <Badge className={getStatusColor(currentStatusPreview.status)}>
                              {currentStatusPreview.status} ({currentStatusPreview.daysLeft} days)
                            </Badge>
                          </div>
                        )}
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={scanForm.control}
                    name="remarks"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-zinc-700">Remarks (Optional)</FormLabel>
                        <FormControl>
                          <Input {...field} className="bg-zinc-50 border-zinc-200" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  {/* Compliance flags */}
                  <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3 space-y-3">
                    <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wide">Compliance Flags</div>
                    {/* Wrong RRP */}
                    <FormField
                      control={scanForm.control}
                      name="wrongRrp"
                      render={({ field }) => (
                        <FormItem className="space-y-0">
                          <div className="flex items-center gap-3">
                            <FormControl>
                              <Checkbox
                                checked={field.value}
                                onCheckedChange={(v) => { field.onChange(v); if (!v) scanForm.setValue("wrongRrpQty", undefined); }}
                                className="data-[state=checked]:bg-red-500 data-[state=checked]:border-red-500"
                              />
                            </FormControl>
                            <FormLabel className="text-sm font-medium text-zinc-800 cursor-pointer flex-1">Wrong RRP on shelf</FormLabel>
                            {watchWrongRrp && (
                              <FormField
                                control={scanForm.control}
                                name="wrongRrpQty"
                                render={({ field: qf }) => (
                                  <FormItem className="space-y-0 flex items-center gap-1">
                                    <FormLabel className="text-xs text-zinc-500 whitespace-nowrap">Qty:</FormLabel>
                                    <FormControl>
                                      <Input
                                        type="number"
                                        min="0"
                                        step="1"
                                        placeholder="0"
                                        className="h-7 w-16 text-xs px-2 border-red-200 focus-visible:ring-red-400"
                                        value={qf.value ?? ""}
                                        onChange={qf.onChange}
                                      />
                                    </FormControl>
                                  </FormItem>
                                )}
                              />
                            )}
                          </div>
                        </FormItem>
                      )}
                    />
                    {/* Missing special ticket */}
                    <FormField
                      control={scanForm.control}
                      name="missingSpecialTicket"
                      render={({ field }) => (
                        <FormItem className="space-y-0">
                          <div className="flex items-center gap-3">
                            <FormControl>
                              <Checkbox
                                checked={field.value}
                                onCheckedChange={(v) => { field.onChange(v); if (!v) scanForm.setValue("missingSpecialQty", undefined); }}
                                className="data-[state=checked]:bg-orange-500 data-[state=checked]:border-orange-500"
                              />
                            </FormControl>
                            <FormLabel className="text-sm font-medium text-zinc-800 cursor-pointer flex-1">Missing special ticket</FormLabel>
                            {watchMissingSpecial && (
                              <FormField
                                control={scanForm.control}
                                name="missingSpecialQty"
                                render={({ field: qf }) => (
                                  <FormItem className="space-y-0 flex items-center gap-1">
                                    <FormLabel className="text-xs text-zinc-500 whitespace-nowrap">Qty:</FormLabel>
                                    <FormControl>
                                      <Input
                                        type="number"
                                        min="0"
                                        step="1"
                                        placeholder="0"
                                        className="h-7 w-16 text-xs px-2 border-orange-200 focus-visible:ring-orange-400"
                                        value={qf.value ?? ""}
                                        onChange={qf.onChange}
                                      />
                                    </FormControl>
                                  </FormItem>
                                )}
                              />
                            )}
                          </div>
                        </FormItem>
                      )}
                    />
                    {/* Not on display */}
                    <FormField
                      control={scanForm.control}
                      name="notOnDisplay"
                      render={({ field }) => (
                        <FormItem className="space-y-0">
                          <div className="flex items-center gap-3">
                            <FormControl>
                              <Checkbox
                                checked={field.value}
                                onCheckedChange={(v) => { field.onChange(v); if (!v) scanForm.setValue("notOnDisplayQty", undefined); }}
                                className="data-[state=checked]:bg-purple-600 data-[state=checked]:border-purple-600"
                              />
                            </FormControl>
                            <FormLabel className="text-sm font-medium text-zinc-800 cursor-pointer flex-1">Not on display (system SOH exists)</FormLabel>
                            {watchNotOnDisplay && (
                              <FormField
                                control={scanForm.control}
                                name="notOnDisplayQty"
                                render={({ field: qf }) => (
                                  <FormItem className="space-y-0 flex items-center gap-1">
                                    <FormLabel className="text-xs text-zinc-500 whitespace-nowrap">Qty:</FormLabel>
                                    <FormControl>
                                      <Input
                                        type="number"
                                        min="0"
                                        step="1"
                                        placeholder="0"
                                        className="h-7 w-16 text-xs px-2 border-purple-200 focus-visible:ring-purple-400"
                                        value={qf.value ?? ""}
                                        onChange={qf.onChange}
                                      />
                                    </FormControl>
                                  </FormItem>
                                )}
                              />
                            )}
                          </div>
                        </FormItem>
                      )}
                    />
                  </div>

                  <Button 
                    type="submit" 
                    className="w-full h-12 mt-4 font-bold text-lg bg-zinc-950 text-white hover:bg-zinc-800 transition-colors"
                    disabled={createScan.isPending || !sessionId}
                  >
                    {createScan.isPending ? "Saving..." : !isOnline ? "Save Offline" : "Save Scan"}
                  </Button>
                  {pendingCount > 0 && isOnline && (
                    <p className="text-xs text-blue-600 text-center mt-1">{pendingCount} scan{pendingCount !== 1 ? "s" : ""} syncing…</p>
                  )}
                  {pendingCount > 0 && !isOnline && (
                    <p className="text-xs text-amber-600 text-center mt-1">{pendingCount} scan{pendingCount !== 1 ? "s" : ""} queued offline</p>
                  )}
                </form>
              </Form>
            </CardContent>
          </Card>

          <Card className="border-zinc-200 shadow-sm bg-white">
            <CardHeader className="pb-3 border-b border-zinc-100">
              <CardTitle className="text-base flex items-center gap-2">
                <FileSpreadsheet className="w-4 h-4 text-zinc-500" />
                Barcode Master Data
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-4 space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-zinc-500">Loaded items:</span>
                <span className="font-bold text-zinc-900 bg-zinc-100 px-2 py-0.5 rounded">{masterData.size.toLocaleString()}</span>
              </div>

              {/* Upload */}
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Input
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    onChange={handleFileUpload}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                    id="master-upload"
                  />
                  <Button variant="outline" className="w-full border-zinc-200 text-zinc-500 text-sm pointer-events-none">
                    <Upload className="w-3.5 h-3.5 mr-2" /> Upload manually
                  </Button>
                </div>
                {masterData.size > 0 && (
                  <Button variant="ghost" className="text-destructive hover:bg-destructive/10 text-sm" onClick={clearMasterData}>
                    Clear
                  </Button>
                )}
              </div>

              {masterData.size === 0 && (
                <Alert className="bg-blue-50 border-blue-200 text-blue-800 py-2">
                  <AlertCircle className="w-4 h-4 text-blue-600" />
                  <AlertDescription className="text-xs ml-2">
                    Upload your barcode master Excel file (.xlsx) to enable item lookups.
                  </AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>

          {/* RRP Data Upload Card */}
          <Card className="border-zinc-200 shadow-sm bg-white">
            <CardHeader className="pb-3 border-b border-zinc-100">
              <CardTitle className="text-base flex items-center gap-2">
                <Tag className="w-4 h-4 text-emerald-500" />
                RRP Data
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-4 space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-zinc-500">Loaded items:</span>
                <span className="font-bold text-zinc-900 bg-zinc-100 px-2 py-0.5 rounded">{rrpCount.toLocaleString()}</span>
              </div>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Input
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    onChange={handleRrpFileUpload}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                  />
                  <Button variant="outline" className="w-full border-zinc-200 text-zinc-500 text-sm pointer-events-none">
                    <Upload className="w-3.5 h-3.5 mr-2" /> Upload RRP file
                  </Button>
                </div>
              </div>
              {rrpCount === 0 && (
                <Alert className="bg-emerald-50 border-emerald-200 text-emerald-800 py-2">
                  <AlertCircle className="w-4 h-4 text-emerald-600" />
                  <AlertDescription className="text-xs ml-2">
                    Upload your Customer Price Group or Specials file to load retail prices.
                  </AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>

          {/* Specials Data Upload Card */}
          <Card className="border-zinc-200 shadow-sm bg-white">
            <CardHeader className="pb-3 border-b border-zinc-100">
              <CardTitle className="text-base flex items-center gap-2">
                <Percent className="w-4 h-4 text-orange-500" />
                Specials / Offers Data
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-4 space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-zinc-500">Loaded items:</span>
                <span className="font-bold text-zinc-900 bg-zinc-100 px-2 py-0.5 rounded">{specialsCount.toLocaleString()}</span>
              </div>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Input
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    onChange={handleSpecialsFileUpload}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                  />
                  <Button variant="outline" className="w-full border-zinc-200 text-zinc-500 text-sm pointer-events-none">
                    <Upload className="w-3.5 h-3.5 mr-2" /> Upload Specials file
                  </Button>
                </div>
              </div>
              {specialsCount === 0 && (
                <Alert className="bg-orange-50 border-orange-200 text-orange-800 py-2">
                  <AlertCircle className="w-4 h-4 text-orange-600" />
                  <AlertDescription className="text-xs ml-2">
                    Upload your Specials/Offers export (.xlsx) to show deal prices per barcode.
                  </AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>

          {/* SOH Data Card */}
          <Card className="border-zinc-200 shadow-sm bg-white">
            <CardHeader className="pb-3 border-b border-zinc-100">
              <CardTitle className="text-base flex items-center gap-2">
                <Database className="w-4 h-4 text-purple-500" />
                System SOH Data
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-4 space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-zinc-500">Loaded items:</span>
                <span className="font-bold text-zinc-900 bg-zinc-100 px-2 py-0.5 rounded">{totalSohItems.toLocaleString()}</span>
              </div>

              {/* Auto-loaded from store portal */}
              {storeSohMeta && storeSohMeta.count > 0 && (
                <Alert className="bg-green-50 border-green-200 text-green-800 py-2">
                  <CheckCircle2 className="w-4 h-4 text-green-600" />
                  <AlertDescription className="text-xs ml-2">
                    Auto-loaded from store portal · {storeSohMeta.count.toLocaleString()} rows
                    {storeSohMeta.uploadedAt && (
                      <span className="block text-green-600">
                        Last upload: {new Date(storeSohMeta.uploadedAt).toLocaleString('en-FJ', { dateStyle: 'medium', timeStyle: 'short' })}
                      </span>
                    )}
                  </AlertDescription>
                </Alert>
              )}

              {/* Manual upload as fallback */}
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Input
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    onChange={handleSohFileUpload}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                    id="soh-upload"
                  />
                  <Button variant="outline" className="w-full border-zinc-200 text-zinc-500 text-sm pointer-events-none">
                    <Upload className="w-3.5 h-3.5 mr-2" /> Upload SOH file manually
                  </Button>
                </div>
                {totalSohItems > 0 && (
                  <Button variant="ghost" className="text-destructive hover:bg-destructive/10 text-sm" onClick={() => { clearSohData(); setStoreSohMeta(null); }}>
                    Clear
                  </Button>
                )}
              </div>

              {totalSohItems === 0 && !storeSohMeta && (
                <Alert className="bg-purple-50 border-purple-200 text-purple-800 py-2">
                  <AlertCircle className="w-4 h-4 text-purple-600" />
                  <AlertDescription className="text-xs ml-2">
                    SOH will auto-load once your store uploads via the Store Portal, or upload a file manually above.
                  </AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>
        </div>

        {/* RIGHT COLUMN: Metrics & List */}
        <div className="space-y-6">
          
          {/* Metrics */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card className="border-zinc-200 shadow-sm">
              <CardContent className="p-4">
                <div className="text-sm font-medium text-zinc-500 mb-1">Total Scans</div>
                <div className="text-2xl font-bold text-zinc-900">{liveSummary.scans}</div>
              </CardContent>
            </Card>
            <Card className="border-red-200 bg-red-50/50 shadow-sm">
              <CardContent className="p-4">
                <div className="text-sm font-medium text-red-700 mb-1">Expired</div>
                <div className="text-2xl font-bold text-red-700">{liveSummary.expiredItems}</div>
              </CardContent>
            </Card>
            <Card className="border-orange-200 bg-orange-50/50 shadow-sm">
              <CardContent className="p-4">
                <div className="text-sm font-medium text-orange-700 mb-1">Urgent</div>
                <div className="text-2xl font-bold text-orange-700">{liveSummary.urgentItems}</div>
              </CardContent>
            </Card>
            <Card className="border-yellow-200 bg-yellow-50/50 shadow-sm">
              <CardContent className="p-4">
                <div className="text-sm font-medium text-yellow-800 mb-1">Near Expiry</div>
                <div className="text-2xl font-bold text-yellow-800">{liveSummary.nearExpiryItems}</div>
              </CardContent>
            </Card>
          </div>

          {/* List */}
          <Card className="border-zinc-200 shadow-sm flex flex-col h-[calc(100dvh-[320px])] min-h-[400px]">
            <CardHeader className="py-4 border-b border-zinc-100 flex flex-row items-center justify-between space-y-0 bg-white rounded-t-xl shrink-0">
              <CardTitle className="text-lg">Recent Scans</CardTitle>
              <div className="flex flex-wrap items-center justify-end gap-3">
                <div className="flex items-center space-x-2">
                  <Switch 
                    id="non-expired" 
                    checked={showNonExpiredOnly}
                    onCheckedChange={setShowNonExpiredOnly}
                  />
                  <Label htmlFor="non-expired" className="text-sm font-medium text-zinc-600">
                    Hide Expired
                  </Label>
                </div>
                <Button onClick={handleExport} size="sm" variant="outline" className="border-zinc-300 font-medium" disabled={visibleScans.length === 0 || isSendingEmail}>
                  <FileSpreadsheet className="w-4 h-4 mr-2 text-green-600" />
                  {isSendingEmail ? "Sending..." : "Export"}
                </Button>
                <Button
                  onClick={handleClearAll}
                  size="sm"
                  variant="outline"
                  className="border-red-200 text-red-700 hover:bg-red-50 hover:text-red-800 font-medium"
                  disabled={scans.length === 0 || clearAllScans.isPending}
                >
                  <Trash2 className="w-4 h-4 mr-2" />
                  {clearAllScans.isPending ? "Clearing..." : "Clear All"}
                </Button>
              </div>
            </CardHeader>
            <CardContent className="p-0 flex-1 overflow-auto bg-white rounded-b-xl">
              {isLoadingScans ? (
                <div className="p-8 text-center text-zinc-500">Loading scans...</div>
              ) : visibleScans.length === 0 ? (
                <div className="p-12 text-center flex flex-col items-center justify-center">
                  <ScanLine className="w-12 h-12 text-zinc-200 mb-4" />
                  <h3 className="text-lg font-medium text-zinc-900 mb-1">No scans yet</h3>
                  <p className="text-zinc-500 text-sm">Start scanning items to build your list.</p>
                </div>
              ) : (
                <Table>
                  <TableHeader className="bg-zinc-50 sticky top-0 z-10">
                    <TableRow className="border-zinc-200 hover:bg-zinc-50">
                      <TableHead className="font-semibold text-zinc-900">Barcode</TableHead>
                      <TableHead className="font-semibold text-zinc-900">Item</TableHead>
                      <TableHead className="font-semibold text-zinc-900">Qty</TableHead>
                      <TableHead className="font-semibold text-zinc-900">Expiry Date</TableHead>
                        <TableHead className="font-semibold text-zinc-900">Status</TableHead>
                        <TableHead className="font-semibold text-zinc-900 text-right">Days Left</TableHead>
                      <TableHead className="text-right font-semibold text-zinc-900">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visibleScans.map((scan) => (
                      <TableRow key={scan.id} className="border-zinc-100 hover:bg-zinc-50/50">
                        <TableCell className="font-mono text-sm">{scan.barcode}</TableCell>
                        <TableCell>
                          <div className="font-medium text-zinc-900">{scan.itemNumber || '-'}</div>
                          <div className="text-xs text-zinc-500 max-w-[150px] truncate" title={scan.description || ''}>{scan.description}</div>
                        </TableCell>
                        <TableCell className="font-mono">{scan.qty}</TableCell>
                        <TableCell className="text-zinc-600">{formatDateOnly(scan.expiryDate)}</TableCell>
                        <TableCell>
                          <Badge className={getStatusColor(scan.status)} variant="outline">
                            {scan.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right font-mono font-semibold text-zinc-900">{scan.daysLeft}</TableCell>
                        <TableCell className="text-right">
                          <Button 
                            variant="ghost" 
                            size="icon" 
                            className="h-8 w-8 text-zinc-400 hover:text-destructive hover:bg-destructive/10"
                            onClick={() => deleteScan.mutate({ id: scan.id })}
                            disabled={deleteScan.isPending}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>
      </main>

      <CameraScanner
        open={cameraOpen}
        onClose={() => setCameraOpen(false)}
        onDetected={(barcode) => {
          cameraScannedRef.current = true;
          scanForm.setValue("barcode", barcode, { shouldValidate: true });
          setTimeout(() => barcodeInputRef.current?.focus(), 100);
        }}
      />
    </div>
  );
}
