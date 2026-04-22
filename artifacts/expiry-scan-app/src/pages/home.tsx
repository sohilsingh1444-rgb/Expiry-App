import { useState, useRef, useEffect, useMemo } from "react";
import { format, differenceInDays, parseISO } from "date-fns";
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
import { AlertCircle, FileSpreadsheet, Trash2, Upload, ScanLine, ArrowRight } from "lucide-react";
import { parseBarcodeMaster, exportToExcel } from "@/lib/xlsx";
import { useBarcodeMaster } from "@/hooks/use-barcode-master";
import { getApiBase } from "@/lib/api-base";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

const setupSchema = z.object({
  pdUserName: z.string().min(1, "PD User Name is required"),
  storeLocation: z.string().min(1, "Store Location is required"),
  scanDate: z.string().min(1, "Scan Date is required"),
});

const scanSchema = z.object({
  barcode: z.string().min(1, "Barcode is required"),
  itemNumber: z.string().optional(),
  description: z.string().optional(),
  qty: z.coerce.number().min(0.01, "Qty must be greater than 0"),
  expiryDate: z.string().min(1, "Expiry Date is required"),
  remarks: z.string().optional(),
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

export default function Home() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isSetupComplete, setIsSetupComplete] = useState(false);
  const [setupData, setSetupData] = useState<{pdUserName: string, storeLocation: string, scanDate: string} | null>(null);
  const [newSessionId, setNewSessionId] = useState<string | null>(null);
  const [showNonExpiredOnly, setShowNonExpiredOnly] = useState(false);
  const [todayDateKey, setTodayDateKey] = useState(getTodayDateKey);
  const [thresholds, setThresholds] = useState({ urgentDays: 2, nearExpiryDays: 15 });
  const barcodeInputRef = useRef<HTMLInputElement>(null);

  const { masterData, isLoaded, saveMasterData, clearMasterData, lookupBarcode } = useBarcodeMaster();

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
    defaultValues: {
      barcode: "",
      itemNumber: "",
      description: "",
      qty: 1,
      expiryDate: "",
      remarks: "",
    },
  });

  const watchBarcode = scanForm.watch("barcode");
  const watchExpiryDate = scanForm.watch("expiryDate");
  const watchQty = scanForm.watch("qty");

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
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (watchBarcode && watchBarcode.length > 3) {
      const match = lookupBarcode(watchBarcode);
      if (match) {
        if (!scanForm.getValues("itemNumber")) {
          scanForm.setValue("itemNumber", match.itemNumber);
        }
        if (!scanForm.getValues("description")) {
          scanForm.setValue("description", match.description);
        }
      }
    }
  }, [watchBarcode, lookupBarcode, scanForm]);

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
          qty: variables.data.qty,
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

        scanForm.reset({ barcode: "", itemNumber: "", description: "", qty: 1, expiryDate: "", remarks: "" });
        setTimeout(() => { barcodeInputRef.current?.focus(); }, 50);
        toast({ title: "Scan saved", description: "Item recorded." });

        return { previousScans };
      },
      onError: (err, _vars, context: { previousScans?: unknown } | undefined) => {
        if (sessionId && context?.previousScans !== undefined) {
          queryClient.setQueryData(getListExpiryScansQueryKey(sessionId), context.previousScans);
        }
        toast({ title: "Failed to save scan", description: String(err), variant: "destructive" });
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
    setSetupData(values);
    setNewSessionId(
      `${values.storeLocation}_${values.pdUserName}_${values.scanDate}_${crypto.randomUUID().slice(0, 8)}`,
    );
    setIsSetupComplete(true);
  };

  const onScanSubmit = (values: z.infer<typeof scanSchema>) => {
    if (!sessionId) {
      toast({ title: "Session not ready", variant: "destructive" });
      return;
    }
    if (!setupData) return;

    let barcodeStr = values.barcode.trim();
    if (barcodeStr.endsWith('.0')) {
      barcodeStr = barcodeStr.slice(0, -2);
    }

    createScan.mutate({
      data: {
        sessionId,
        pdUserName: setupData.pdUserName,
        storeLocation: setupData.storeLocation,
        scanDate: setupData.scanDate,
        barcode: barcodeStr,
        itemNumber: values.itemNumber,
        description: values.description,
        qty: values.qty,
        expiryDate: values.expiryDate,
        remarks: values.remarks,
      }
    });
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const data = await parseBarcodeMaster(file);
      saveMasterData(data);
      toast({
        title: "Master Data Uploaded",
        description: `Loaded ${data.length} rows successfully.`,
      });
    } catch (err) {
      toast({
        title: "Upload Failed",
        description: "Failed to parse the Excel file.",
        variant: "destructive",
      });
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
    const exportData = visibleScans.map(s => ({
      "PD User Name": s.pdUserName,
      "Store Location": s.storeLocation,
      "Barcode": s.barcode,
      "Item Number": s.itemNumber,
      "Description": s.description,
      "Qty": s.qty,
      "Expiry Date": formatDateOnly(s.expiryDate),
      "Status": s.status,
      "Days Left": s.daysLeft,
      "Scan Date": formatDateOnly(s.scanDate),
      "Action Required": s.actionRequired,
      "Remarks": s.remarks,
    }));
    await exportToExcel(exportData, `Expiry_Scans_${setupData?.storeLocation || 'Export'}_${format(new Date(), 'yyyyMMdd_HHmm')}`);

    if (sessionId) {
      try {
        await fetch(`${API_BASE}/api/expiry-sessions/${sessionId}`, { method: "DELETE" });
        queryClient.invalidateQueries({ queryKey: getListExpiryScansQueryKey(sessionId) });
        queryClient.invalidateQueries({ queryKey: getGetExpirySessionSummaryQueryKey(sessionId) });
        toast({
          title: "Exported and cleared",
          description: "Excel downloaded. Session data removed from database to save space.",
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
              <CardTitle className="text-2xl font-bold tracking-tight">Expiry Scan</CardTitle>
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
                      <FormControl>
                        <Input placeholder="e.g. Store 101" className="bg-white border-zinc-300" {...field} />
                      </FormControl>
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
            <h1 className="text-xl font-bold tracking-tight hidden sm:block">Expiry Scan</h1>
          </div>
          <div className="flex items-center gap-4 text-sm font-medium text-zinc-300">
            <div className="flex items-center gap-1.5 bg-zinc-900 px-3 py-1.5 rounded-md border border-zinc-800">
              <span className="text-zinc-500">Loc:</span> <span className="text-amber-500">{setupData?.storeLocation}</span>
            </div>
            <div className="flex items-center gap-1.5 bg-zinc-900 px-3 py-1.5 rounded-md border border-zinc-800">
              <span className="text-zinc-500">User:</span> <span className="text-amber-500">{setupData?.pdUserName}</span>
            </div>
            <Button variant="ghost" size="sm" className="text-zinc-400 hover:text-white" onClick={() => setIsSetupComplete(false)}>
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
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  
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
                            <Input type="number" step="0.01" {...field} className="bg-zinc-50 border-zinc-200 font-mono" />
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

                  <Button 
                    type="submit" 
                    className="w-full h-12 mt-4 font-bold text-lg bg-zinc-950 text-white hover:bg-zinc-800 transition-colors"
                    disabled={createScan.isPending || !sessionId}
                  >
                    {createScan.isPending ? "Saving..." : "Save Scan"}
                  </Button>
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
            <CardContent className="pt-4 space-y-4">
              <div className="flex items-center justify-between text-sm">
                <span className="text-zinc-500">Loaded items:</span>
                <span className="font-bold text-zinc-900 bg-zinc-100 px-2 py-0.5 rounded">{masterData.size.toLocaleString()}</span>
              </div>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Input 
                    type="file" 
                    accept=".xlsx,.xls,.csv" 
                    onChange={handleFileUpload}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                    id="master-upload"
                  />
                  <Button variant="outline" className="w-full border-zinc-300 pointer-events-none">
                    <Upload className="w-4 h-4 mr-2" /> Upload Excel
                  </Button>
                </div>
                {masterData.size > 0 && (
                  <Button variant="ghost" className="text-destructive hover:bg-destructive/10" onClick={clearMasterData}>
                    Clear
                  </Button>
                )}
              </div>
              {masterData.size === 0 && (
                <Alert className="bg-blue-50 border-blue-200 text-blue-800 pb-3 pt-3">
                  <AlertCircle className="w-4 h-4 text-blue-600" />
                  <AlertDescription className="text-xs ml-2">
                    Upload a master list to auto-fill item details when scanning barcodes.
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
                <Button onClick={handleExport} size="sm" variant="outline" className="border-zinc-300 font-medium" disabled={visibleScans.length === 0}>
                  <FileSpreadsheet className="w-4 h-4 mr-2 text-green-600" />
                  Export
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
    </div>
  );
}
