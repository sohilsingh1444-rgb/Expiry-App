import { useState, useEffect, useRef } from "react";
import { parseBarcodeMaster, parseSohFile } from "@/lib/xlsx";
import { buildBarcodeMaps } from "@/hooks/use-barcode-master";
import { buildSohMaps } from "@/hooks/use-soh-data";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Trash2, Settings, LogOut, ShieldCheck, Store, Plus, Pencil, X, Upload, DatabaseZap } from "lucide-react";
import { format, parseISO } from "date-fns";
import { getApiBase } from "@/lib/api-base";

function apiUrl(path: string) {
  return `${getApiBase()}/api${path}`;
}

type Session = {
  sessionId: string;
  pdUserName: string;
  storeLocation: string;
  scanDate: string;
  scanCount: number;
  createdAt: string;
};

type AppSettings = {
  urgentDays: number;
  nearExpiryDays: number;
};

type StoreRow = {
  code: string;
  name: string;
  region: string;
  emails: string[];
};

export default function AdminPage() {
  const { toast } = useToast();
  const [password, setPassword] = useState("");
  const [authed, setAuthed] = useState(false);
  const [authError, setAuthError] = useState("");
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  const [sessions, setSessions] = useState<Session[]>([]);
  const [isLoadingSessions, setIsLoadingSessions] = useState(false);

  const [settings, setSettings] = useState<AppSettings>({ urgentDays: 2, nearExpiryDays: 15 });
  const [urgentInput, setUrgentInput] = useState("2");
  const [nearExpiryInput, setNearExpiryInput] = useState("15");
  const [isSavingSettings, setIsSavingSettings] = useState(false);

  const [stores, setStores] = useState<StoreRow[]>([]);
  const [isLoadingStores, setIsLoadingStores] = useState(false);
  const [storeDialog, setStoreDialog] = useState<{ open: boolean; editing: StoreRow | null }>({ open: false, editing: null });

  type MasterMeta = { uploadedAt: string | null; count: number };
  const [bmMeta, setBmMeta] = useState<MasterMeta>({ uploadedAt: null, count: 0 });
  const [bmUploading, setBmUploading] = useState(false);
  const [sohMeta, setSohMeta] = useState<MasterMeta>({ uploadedAt: null, count: 0 });
  const [sohUploading, setSohUploading] = useState(false);
  const bmFileRef = useRef<HTMLInputElement>(null);
  const sohFileRef = useRef<HTMLInputElement>(null);
  const [storeCode, setStoreCode] = useState("");
  const [storeName, setStoreName] = useState("");
  const [storeRegion, setStoreRegion] = useState<"WR" | "CR" | "NR">("WR");
  const [storeEmailsRaw, setStoreEmailsRaw] = useState("");
  const [isSavingStore, setIsSavingStore] = useState(false);

  const storedPassword = () => sessionStorage.getItem("admin_pw") ?? "";

  useEffect(() => {
    const saved = sessionStorage.getItem("admin_pw");
    if (saved) {
      verifyAndLoad(saved);
    }
  }, []);

  async function verifyAndLoad(pw: string) {
    setIsLoggingIn(true);
    setAuthError("");
    try {
      const res = await fetch(apiUrl("/admin/verify"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw }),
      });
      if (!res.ok) {
        setAuthError("Incorrect password. Please try again.");
        sessionStorage.removeItem("admin_pw");
        setAuthed(false);
        return;
      }
      sessionStorage.setItem("admin_pw", pw);
      setAuthed(true);
      await Promise.all([loadSessions(pw), loadSettings(), loadStores(pw), loadMasterMeta()]);
    } catch {
      setAuthError("Connection error. Please try again.");
    } finally {
      setIsLoggingIn(false);
    }
  }

  async function loadSessions(pw: string) {
    setIsLoadingSessions(true);
    try {
      const res = await fetch(apiUrl("/admin/sessions"), {
        headers: { "x-admin-password": pw },
      });
      if (res.ok) {
        setSessions(await res.json());
      }
    } finally {
      setIsLoadingSessions(false);
    }
  }

  async function loadSettings() {
    const res = await fetch(apiUrl("/admin/settings"));
    if (res.ok) {
      const data: AppSettings = await res.json();
      setSettings(data);
      setUrgentInput(String(data.urgentDays));
      setNearExpiryInput(String(data.nearExpiryDays));
    }
  }

  async function loadMasterMeta() {
    const [bmRes, sohRes] = await Promise.all([
      fetch(apiUrl("/barcode-master/meta")),
      fetch(apiUrl("/soh-data/meta")),
    ]);
    if (bmRes.ok) setBmMeta(await bmRes.json());
    if (sohRes.ok) setSohMeta(await sohRes.json());
  }

  async function loadStores(pw: string) {
    setIsLoadingStores(true);
    try {
      const res = await fetch(apiUrl("/admin/stores"), {
        headers: { "x-admin-password": pw },
      });
      if (res.ok) {
        setStores(await res.json());
      }
    } finally {
      setIsLoadingStores(false);
    }
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    await verifyAndLoad(password);
  }

  function handleLogout() {
    sessionStorage.removeItem("admin_pw");
    setAuthed(false);
    setPassword("");
    setSessions([]);
    setStores([]);
  }

  async function handleDeleteSession(sessionId: string) {
    const pw = storedPassword();
    const res = await fetch(apiUrl(`/admin/sessions/${sessionId}`), {
      method: "DELETE",
      headers: { "x-admin-password": pw },
    });
    if (res.ok) {
      setSessions((prev) => prev.filter((s) => s.sessionId !== sessionId));
      toast({ title: "Session deleted", description: "All scans in the session were removed." });
    } else {
      toast({ title: "Error", description: "Failed to delete session.", variant: "destructive" });
    }
  }

  async function handleBarcodeMasterUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    const pw = storedPassword();
    setBmUploading(true);
    try {
      const rows = await parseBarcodeMaster(file);
      if (!rows.length) {
        toast({ title: "Empty file", description: "No rows found in the file.", variant: "destructive" });
        return;
      }
      const { map, count } = buildBarcodeMaps(rows);
      const res = await fetch(apiUrl("/admin/barcode-master"), {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-password": pw },
        body: JSON.stringify({ map, count }),
      });
      if (res.ok) {
        const data = await res.json();
        setBmMeta({ uploadedAt: data.uploadedAt, count: data.count });
        toast({ title: "Barcode Master uploaded", description: `${Number(data.count).toLocaleString()} items stored. All devices will auto-load on next open.` });
      } else {
        const text = await res.text();
        let errMsg = `Upload failed (${res.status})`;
        if (res.status === 413) errMsg = "File is too large to upload. Try exporting only essential columns.";
        else { try { errMsg = (JSON.parse(text) as { error?: string }).error ?? errMsg; } catch { /* non-JSON */ } }
        toast({ title: "Upload failed", description: errMsg, variant: "destructive" });
      }
    } catch (err) {
      toast({ title: "Upload error", description: err instanceof Error ? err.message : "Failed to read or upload file.", variant: "destructive" });
    } finally {
      setBmUploading(false);
    }
  }

  async function handleSohUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    const pw = storedPassword();
    setSohUploading(true);
    try {
      const rows = await parseSohFile(file);
      if (!rows.length) {
        toast({ title: "Empty file", description: "No rows found in the file.", variant: "destructive" });
        return;
      }
      const { byBarcode, byItem, count } = buildSohMaps(rows);
      const res = await fetch(apiUrl("/admin/soh-data"), {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-password": pw },
        body: JSON.stringify({ byBarcode, byItem, count }),
      });
      if (res.ok) {
        const data = await res.json();
        setSohMeta({ uploadedAt: data.uploadedAt, count: data.count });
        toast({ title: "SOH Data uploaded", description: `${Number(data.count).toLocaleString()} items stored. All devices will auto-load on next open.` });
      } else {
        const text = await res.text();
        let errMsg = `Upload failed (${res.status})`;
        if (res.status === 413) errMsg = "File is too large to upload. Try exporting only essential columns.";
        else { try { errMsg = (JSON.parse(text) as { error?: string }).error ?? errMsg; } catch { /* non-JSON */ } }
        toast({ title: "Upload failed", description: errMsg, variant: "destructive" });
      }
    } catch (err) {
      toast({ title: "Upload error", description: err instanceof Error ? err.message : "Failed to read or upload file.", variant: "destructive" });
    } finally {
      setSohUploading(false);
    }
  }

  async function handleClearBm() {
    const pw = storedPassword();
    const res = await fetch(apiUrl("/admin/barcode-master"), {
      method: "DELETE",
      headers: { "x-admin-password": pw },
    });
    if (res.ok) {
      setBmMeta({ uploadedAt: null, count: 0 });
      toast({ title: "Barcode Master cleared", description: "Removed from server. Devices will fall back to local uploads." });
    }
  }

  async function handleClearSoh() {
    const pw = storedPassword();
    const res = await fetch(apiUrl("/admin/soh-data"), {
      method: "DELETE",
      headers: { "x-admin-password": pw },
    });
    if (res.ok) {
      setSohMeta({ uploadedAt: null, count: 0 });
      toast({ title: "SOH Data cleared", description: "Removed from server. Devices will fall back to local uploads." });
    }
  }

  async function handleSaveSettings(e: React.FormEvent) {
    e.preventDefault();
    const urgentDays = Number(urgentInput);
    const nearExpiryDays = Number(nearExpiryInput);

    if (!Number.isInteger(urgentDays) || urgentDays < 0) {
      toast({ title: "Invalid value", description: "Urgent Days must be 0 or more.", variant: "destructive" });
      return;
    }
    if (!Number.isInteger(nearExpiryDays) || nearExpiryDays <= urgentDays) {
      toast({ title: "Invalid value", description: "Near Expiry Days must be greater than Urgent Days.", variant: "destructive" });
      return;
    }

    setIsSavingSettings(true);
    const pw = storedPassword();
    try {
      const res = await fetch(apiUrl("/admin/settings"), {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "x-admin-password": pw,
        },
        body: JSON.stringify({ urgentDays, nearExpiryDays }),
      });
      if (res.ok) {
        const data: AppSettings = await res.json();
        setSettings(data);
        toast({ title: "Settings saved", description: `Urgent: ≤${data.urgentDays} days, Near Expiry: ≤${data.nearExpiryDays} days` });
      } else {
        const err = await res.json();
        toast({ title: "Error", description: err.error ?? "Failed to save settings.", variant: "destructive" });
      }
    } finally {
      setIsSavingSettings(false);
    }
  }

  function openAddStore() {
    setStoreCode("");
    setStoreName("");
    setStoreRegion("WR");
    setStoreEmailsRaw("");
    setStoreDialog({ open: true, editing: null });
  }

  function openEditStore(store: StoreRow) {
    setStoreCode(store.code);
    setStoreName(store.name);
    setStoreRegion((store.region as "WR" | "CR" | "NR") || "WR");
    setStoreEmailsRaw(store.emails.join(", "));
    setStoreDialog({ open: true, editing: store });
  }

  function closeStoreDialog() {
    setStoreDialog({ open: false, editing: null });
  }

  async function handleSaveStore(e: React.FormEvent) {
    e.preventDefault();
    const emails = storeEmailsRaw
      .split(/[,\n]+/)
      .map((e) => e.trim())
      .filter(Boolean);
    const pw = storedPassword();
    setIsSavingStore(true);
    try {
      if (storeDialog.editing) {
        const res = await fetch(apiUrl(`/admin/stores/${storeDialog.editing.code}`), {
          method: "PUT",
          headers: { "Content-Type": "application/json", "x-admin-password": pw },
          body: JSON.stringify({ name: storeName, region: storeRegion, emails }),
        });
        if (res.ok) {
          const updated: StoreRow = await res.json();
          setStores((prev) => prev.map((s) => (s.code === updated.code ? updated : s)));
          toast({ title: "Store updated", description: `${updated.name} saved.` });
          closeStoreDialog();
        } else {
          const err = await res.json();
          toast({ title: "Error", description: err.error ?? "Failed to update store.", variant: "destructive" });
        }
      } else {
        const res = await fetch(apiUrl("/admin/stores"), {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-admin-password": pw },
          body: JSON.stringify({ code: storeCode, name: storeName, region: storeRegion, emails }),
        });
        if (res.ok) {
          const created: StoreRow = await res.json();
          setStores((prev) => [...prev, created].sort((a, b) => a.code.localeCompare(b.code)));
          toast({ title: "Store added", description: `${created.name} added.` });
          closeStoreDialog();
        } else {
          const err = await res.json();
          toast({ title: "Error", description: err.detail ? `${err.error}: ${err.detail}` : (err.error ?? "Failed to add store."), variant: "destructive" });
        }
      }
    } finally {
      setIsSavingStore(false);
    }
  }

  async function handleDeleteStore(code: string) {
    const pw = storedPassword();
    const res = await fetch(apiUrl(`/admin/stores/${code}`), {
      method: "DELETE",
      headers: { "x-admin-password": pw },
    });
    if (res.ok) {
      setStores((prev) => prev.filter((s) => s.code !== code));
      toast({ title: "Store removed", description: `Store ${code} deleted.` });
    } else {
      toast({ title: "Error", description: "Failed to delete store.", variant: "destructive" });
    }
  }

  if (!authed) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
        <Card className="w-full max-w-sm bg-zinc-900 border-zinc-800">
          <CardHeader className="text-center">
            <div className="flex justify-center mb-2">
              <ShieldCheck className="h-8 w-8 text-amber-500" />
            </div>
            <CardTitle className="text-white text-xl">Admin Panel</CardTitle>
            <CardDescription className="text-zinc-400">Expiry Tracker — Admin Access</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleLogin} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="admin-pw" className="text-zinc-300">Password</Label>
                <Input
                  id="admin-pw"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter admin password"
                  className="bg-zinc-800 border-zinc-700 text-white placeholder:text-zinc-500"
                  autoFocus
                />
                {authError && <p className="text-red-400 text-sm">{authError}</p>}
              </div>
              <Button
                type="submit"
                className="w-full bg-amber-600 hover:bg-amber-500 text-white"
                disabled={isLoggingIn || !password}
              >
                {isLoggingIn ? "Verifying..." : "Login"}
              </Button>
              <div className="text-center">
                <a href="/" className="text-zinc-500 text-sm hover:text-zinc-300 underline">
                  Back to app
                </a>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      <header className="bg-zinc-900 border-b border-zinc-800 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <ShieldCheck className="h-5 w-5 text-amber-500" />
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Admin Panel</h1>
            <p className="text-zinc-500 text-xs">Expiry Tracker</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <a href="/" className="text-zinc-400 text-sm hover:text-white transition-colors">Back to App</a>
          <Button
            variant="outline"
            size="sm"
            onClick={handleLogout}
            className="border-zinc-700 text-zinc-300 hover:bg-zinc-800 hover:text-white"
          >
            <LogOut className="h-4 w-4 mr-1.5" />
            Logout
          </Button>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-8 space-y-8">

        {/* ── Expiry Thresholds ── */}
        <Card className="bg-zinc-900 border-zinc-800">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Settings className="h-4 w-4 text-amber-500" />
              <CardTitle className="text-white text-base">Expiry Thresholds</CardTitle>
            </div>
            <CardDescription className="text-zinc-400">
              Current: Urgent ≤ {settings.urgentDays} days &nbsp;|&nbsp; Near Expiry ≤ {settings.nearExpiryDays} days
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSaveSettings} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-zinc-300">Urgent (days left ≤ X)</Label>
                  <Input
                    type="number"
                    min={0}
                    value={urgentInput}
                    onChange={(e) => setUrgentInput(e.target.value)}
                    className="bg-zinc-800 border-zinc-700 text-white"
                  />
                  <p className="text-zinc-500 text-xs">Items expiring within this many days are flagged Urgent</p>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-zinc-300">Near Expiry (days left ≤ X)</Label>
                  <Input
                    type="number"
                    min={1}
                    value={nearExpiryInput}
                    onChange={(e) => setNearExpiryInput(e.target.value)}
                    className="bg-zinc-800 border-zinc-700 text-white"
                  />
                  <p className="text-zinc-500 text-xs">Items expiring within this many days (but above Urgent) are Near Expiry</p>
                </div>
              </div>
              <Button
                type="submit"
                className="bg-amber-600 hover:bg-amber-500 text-white"
                disabled={isSavingSettings}
              >
                {isSavingSettings ? "Saving..." : "Save Thresholds"}
              </Button>
            </form>
          </CardContent>
        </Card>

        {/* ── Stores & Emails ── */}
        <Card className="bg-zinc-900 border-zinc-800">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Store className="h-4 w-4 text-amber-500" />
                <CardTitle className="text-white text-base">Stores & Email Recipients</CardTitle>
              </div>
              <Button
                size="sm"
                className="bg-amber-600 hover:bg-amber-500 text-white h-8"
                onClick={openAddStore}
              >
                <Plus className="h-3.5 w-3.5 mr-1.5" />
                Add Store
              </Button>
            </div>
            <CardDescription className="text-zinc-400">
              {stores.length === 0
                ? "No stores configured"
                : `${stores.length} store${stores.length !== 1 ? "s" : ""} — scan export emails go to the addresses listed here`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoadingStores ? (
              <p className="text-zinc-500 text-sm">Loading stores...</p>
            ) : stores.length === 0 ? (
              <p className="text-zinc-500 text-sm">No stores yet. Click "Add Store" to add one.</p>
            ) : (
              <div className="rounded-md border border-zinc-800 overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-zinc-800 hover:bg-zinc-800 border-zinc-700">
                      <TableHead className="text-zinc-300 w-24">Code</TableHead>
                      <TableHead className="text-zinc-300 w-16">Region</TableHead>
                      <TableHead className="text-zinc-300">Store Name</TableHead>
                      <TableHead className="text-zinc-300">Email Recipients</TableHead>
                      <TableHead className="w-20"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {stores.map((store) => (
                      <TableRow key={store.code} className="border-zinc-800 hover:bg-zinc-800/50">
                        <TableCell className="text-amber-400 font-mono font-semibold">{store.code}</TableCell>
                        <TableCell>
                          <span className={`text-xs font-bold px-1.5 py-0.5 rounded font-mono ${store.region === "NR" ? "bg-blue-900/50 text-blue-300" : store.region === "CR" ? "bg-emerald-900/50 text-emerald-300" : "bg-amber-900/50 text-amber-300"}`}>
                            {store.region || "WR"}
                          </span>
                        </TableCell>
                        <TableCell className="text-white">{store.name}</TableCell>
                        <TableCell className="text-zinc-400 text-sm">
                          {store.emails.length === 0
                            ? <span className="text-zinc-600 italic">No emails</span>
                            : store.emails.join(", ")}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1 justify-end">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-zinc-500 hover:text-amber-400 hover:bg-amber-950/30"
                              onClick={() => openEditStore(store)}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 text-zinc-500 hover:text-red-400 hover:bg-red-950/40"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              </AlertDialogTrigger>
                              <AlertDialogContent className="bg-zinc-900 border-zinc-700">
                                <AlertDialogHeader>
                                  <AlertDialogTitle className="text-white">Delete store?</AlertDialogTitle>
                                  <AlertDialogDescription className="text-zinc-400">
                                    Remove <strong className="text-white">{store.name}</strong> ({store.code}) from the list?
                                    Export emails will no longer be sent to this store.
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel className="border-zinc-700 text-zinc-300 hover:bg-zinc-800">Cancel</AlertDialogCancel>
                                  <AlertDialogAction
                                    onClick={() => handleDeleteStore(store.code)}
                                    className="bg-red-600 hover:bg-red-700 text-white"
                                  >
                                    Delete
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* ── Master Data ── */}
        <Card className="bg-zinc-900 border-zinc-800">
          <CardHeader>
            <div className="flex items-center gap-2">
              <DatabaseZap className="h-4 w-4 text-amber-500" />
              <CardTitle className="text-white text-base">Master Data</CardTitle>
            </div>
            <CardDescription className="text-zinc-400">
              Upload once here — all devices auto-load the latest file on next open. No manual uploads needed at each store.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">

            {/* Barcode Master */}
            <div className="rounded-lg border border-zinc-800 p-4 space-y-3">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-white font-medium text-sm">Barcode Master</p>
                  <p className="text-zinc-500 text-xs mt-0.5">
                    Item descriptions, RRP and special prices by region (CRWR / NR)
                  </p>
                </div>
                {bmMeta.uploadedAt ? (
                  <span className="text-xs bg-emerald-900/40 text-emerald-400 border border-emerald-800 rounded px-2 py-0.5 whitespace-nowrap shrink-0">
                    {bmMeta.count.toLocaleString()} items
                  </span>
                ) : (
                  <span className="text-xs bg-zinc-800 text-zinc-500 border border-zinc-700 rounded px-2 py-0.5 whitespace-nowrap shrink-0">
                    Not uploaded
                  </span>
                )}
              </div>

              {bmMeta.uploadedAt && (
                <p className="text-zinc-500 text-xs">
                  Last uploaded: {format(new Date(bmMeta.uploadedAt), "dd/MM/yyyy HH:mm")}
                </p>
              )}

              <div className="flex items-center gap-2">
                <input
                  ref={bmFileRef}
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  className="hidden"
                  onChange={handleBarcodeMasterUpload}
                />
                <Button
                  size="sm"
                  className="bg-amber-600 hover:bg-amber-500 text-white h-8"
                  disabled={bmUploading}
                  onClick={() => bmFileRef.current?.click()}
                >
                  <Upload className="h-3.5 w-3.5 mr-1.5" />
                  {bmUploading ? "Uploading…" : bmMeta.uploadedAt ? "Replace File" : "Upload File"}
                </Button>
                {bmMeta.uploadedAt && (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 text-zinc-500 hover:text-red-400 hover:bg-red-950/30 text-xs"
                        disabled={bmUploading}
                      >
                        <Trash2 className="h-3.5 w-3.5 mr-1" />
                        Clear
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent className="bg-zinc-900 border-zinc-700">
                      <AlertDialogHeader>
                        <AlertDialogTitle className="text-white">Clear Barcode Master?</AlertDialogTitle>
                        <AlertDialogDescription className="text-zinc-400">
                          This removes the server-side Barcode Master. Devices will fall back to their local uploads until a new file is uploaded here.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel className="border-zinc-700 text-zinc-300 hover:bg-zinc-800">Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={handleClearBm} className="bg-red-600 hover:bg-red-700 text-white">
                          Clear
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}
              </div>
            </div>

            {/* SOH Data */}
            <div className="rounded-lg border border-zinc-800 p-4 space-y-3">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-white font-medium text-sm">System SOH (Stock on Hand)</p>
                  <p className="text-zinc-500 text-xs mt-0.5">
                    Current stock quantities used to calculate bulk pull quantities
                  </p>
                </div>
                {sohMeta.uploadedAt ? (
                  <span className="text-xs bg-emerald-900/40 text-emerald-400 border border-emerald-800 rounded px-2 py-0.5 whitespace-nowrap shrink-0">
                    {sohMeta.count.toLocaleString()} items
                  </span>
                ) : (
                  <span className="text-xs bg-zinc-800 text-zinc-500 border border-zinc-700 rounded px-2 py-0.5 whitespace-nowrap shrink-0">
                    Not uploaded
                  </span>
                )}
              </div>

              {sohMeta.uploadedAt && (
                <p className="text-zinc-500 text-xs">
                  Last uploaded: {format(new Date(sohMeta.uploadedAt), "dd/MM/yyyy HH:mm")}
                </p>
              )}

              <div className="flex items-center gap-2">
                <input
                  ref={sohFileRef}
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  className="hidden"
                  onChange={handleSohUpload}
                />
                <Button
                  size="sm"
                  className="bg-amber-600 hover:bg-amber-500 text-white h-8"
                  disabled={sohUploading}
                  onClick={() => sohFileRef.current?.click()}
                >
                  <Upload className="h-3.5 w-3.5 mr-1.5" />
                  {sohUploading ? "Uploading…" : sohMeta.uploadedAt ? "Replace File" : "Upload File"}
                </Button>
                {sohMeta.uploadedAt && (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 text-zinc-500 hover:text-red-400 hover:bg-red-950/30 text-xs"
                        disabled={sohUploading}
                      >
                        <Trash2 className="h-3.5 w-3.5 mr-1" />
                        Clear
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent className="bg-zinc-900 border-zinc-700">
                      <AlertDialogHeader>
                        <AlertDialogTitle className="text-white">Clear SOH Data?</AlertDialogTitle>
                        <AlertDialogDescription className="text-zinc-400">
                          This removes the server-side SOH data. Devices will fall back to their local uploads until a new file is uploaded here.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel className="border-zinc-700 text-zinc-300 hover:bg-zinc-800">Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={handleClearSoh} className="bg-red-600 hover:bg-red-700 text-white">
                          Clear
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}
              </div>
            </div>

          </CardContent>
        </Card>

        {/* ── Past Sessions ── */}
        <Card className="bg-zinc-900 border-zinc-800">
          <CardHeader>
            <CardTitle className="text-white text-base">Past Sessions</CardTitle>
            <CardDescription className="text-zinc-400">
              {sessions.length === 0
                ? "No sessions found"
                : `${sessions.length} session${sessions.length !== 1 ? "s" : ""} in the database`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoadingSessions ? (
              <p className="text-zinc-500 text-sm">Loading sessions...</p>
            ) : sessions.length === 0 ? (
              <p className="text-zinc-500 text-sm">No sessions recorded yet.</p>
            ) : (
              <div className="rounded-md border border-zinc-800 overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-zinc-800 hover:bg-zinc-800 border-zinc-700">
                      <TableHead className="text-zinc-300">PD User</TableHead>
                      <TableHead className="text-zinc-300">Store</TableHead>
                      <TableHead className="text-zinc-300">Scan Date</TableHead>
                      <TableHead className="text-zinc-300 text-right">Scans</TableHead>
                      <TableHead className="text-zinc-300">Created</TableHead>
                      <TableHead className="w-16"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sessions.map((session) => (
                      <TableRow key={session.sessionId} className="border-zinc-800 hover:bg-zinc-800/50">
                        <TableCell className="text-white font-medium">{session.pdUserName}</TableCell>
                        <TableCell className="text-zinc-300">{session.storeLocation}</TableCell>
                        <TableCell className="text-zinc-300">
                          {format(parseISO(session.scanDate), "dd/MM/yyyy")}
                        </TableCell>
                        <TableCell className="text-zinc-300 text-right">{session.scanCount}</TableCell>
                        <TableCell className="text-zinc-500 text-sm">
                          {format(new Date(session.createdAt), "dd/MM/yyyy HH:mm")}
                        </TableCell>
                        <TableCell>
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="text-zinc-500 hover:text-red-400 hover:bg-red-950/40"
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent className="bg-zinc-900 border-zinc-700">
                              <AlertDialogHeader>
                                <AlertDialogTitle className="text-white">Delete session?</AlertDialogTitle>
                                <AlertDialogDescription className="text-zinc-400">
                                  This will permanently delete all {session.scanCount} scan{session.scanCount !== 1 ? "s" : ""} from{" "}
                                  <strong className="text-white">{session.pdUserName}</strong> at{" "}
                                  <strong className="text-white">{session.storeLocation}</strong> on{" "}
                                  <strong className="text-white">{format(parseISO(session.scanDate), "dd/MM/yyyy")}</strong>.
                                  This cannot be undone.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel className="border-zinc-700 text-zinc-300 hover:bg-zinc-800">
                                  Cancel
                                </AlertDialogCancel>
                                <AlertDialogAction
                                  onClick={() => handleDeleteSession(session.sessionId)}
                                  className="bg-red-600 hover:bg-red-700 text-white"
                                >
                                  Delete
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </main>

      {/* ── Store Add/Edit Dialog ── */}
      <Dialog open={storeDialog.open} onOpenChange={(open) => !open && closeStoreDialog()}>
        <DialogContent className="bg-zinc-900 border-zinc-700 text-white max-w-lg">
          <DialogHeader>
            <DialogTitle>{storeDialog.editing ? "Edit Store" : "Add Store"}</DialogTitle>
            <DialogDescription className="text-zinc-400">
              {storeDialog.editing
                ? `Editing ${storeDialog.editing.code} — you can update the name and email recipients.`
                : "Enter the store code, name, and email recipients for export reports."}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSaveStore} className="space-y-4 mt-2">
            {!storeDialog.editing && (
              <div className="space-y-1.5">
                <Label className="text-zinc-300">Store Code</Label>
                <Input
                  value={storeCode}
                  onChange={(e) => setStoreCode(e.target.value.toUpperCase())}
                  placeholder="e.g. S0042"
                  className="bg-zinc-800 border-zinc-700 text-white font-mono placeholder:text-zinc-600"
                  required
                />
                <p className="text-zinc-500 text-xs">Used for store selection — must be unique</p>
              </div>
            )}
            <div className="space-y-1.5">
              <Label className="text-zinc-300">Store Name</Label>
              <Input
                value={storeName}
                onChange={(e) => setStoreName(e.target.value)}
                placeholder="e.g. Newworld Suva Central"
                className="bg-zinc-800 border-zinc-700 text-white placeholder:text-zinc-600"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-zinc-300">Region</Label>
              <div className="flex gap-2">
                {(["WR", "CR", "NR"] as const).map(r => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setStoreRegion(r)}
                    className={`flex-1 py-2 rounded-md text-sm font-bold border transition-colors ${storeRegion === r ? (r === "NR" ? "bg-blue-700 border-blue-600 text-white" : r === "CR" ? "bg-emerald-700 border-emerald-600 text-white" : "bg-amber-600 border-amber-500 text-white") : "bg-zinc-800 border-zinc-700 text-zinc-400 hover:bg-zinc-700"}`}
                  >
                    {r === "WR" ? "Western (WR)" : r === "CR" ? "Central (CR)" : "Northern (NR)"}
                  </button>
                ))}
              </div>
              <p className="text-zinc-500 text-xs">Region determines which RRP/Special Price columns are used from the barcode master</p>
            </div>
            <div className="space-y-1.5">
              <Label className="text-zinc-300">Email Recipients</Label>
              <textarea
                value={storeEmailsRaw}
                onChange={(e) => setStoreEmailsRaw(e.target.value)}
                placeholder={"email1@newworld.com.fj, email2@newworld.com.fj\n(one per line or comma-separated)"}
                rows={3}
                className="w-full rounded-md bg-zinc-800 border border-zinc-700 text-white text-sm px-3 py-2 placeholder:text-zinc-600 resize-none focus:outline-none focus:ring-2 focus:ring-amber-500"
              />
              <p className="text-zinc-500 text-xs">Separate multiple emails with commas or new lines</p>
            </div>
            <DialogFooter className="gap-2 mt-4">
              <Button
                type="button"
                variant="outline"
                className="border-zinc-700 text-zinc-300 hover:bg-zinc-800"
                onClick={closeStoreDialog}
              >
                <X className="h-4 w-4 mr-1.5" />
                Cancel
              </Button>
              <Button
                type="submit"
                className="bg-amber-600 hover:bg-amber-500 text-white"
                disabled={isSavingStore}
              >
                {isSavingStore ? "Saving..." : storeDialog.editing ? "Save Changes" : "Add Store"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
