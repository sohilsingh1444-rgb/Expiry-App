import { useState, useRef, useCallback } from "react";
import { parseSohFile } from "@/lib/xlsx";
import { buildSohMaps } from "@/hooks/use-soh-data";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Upload, LogOut, KeyRound, Database, CheckCircle2, AlertCircle, Eye, EyeOff } from "lucide-react";
import { format, parseISO } from "date-fns";
import { getApiBase } from "@/lib/api-base";
import { STORES } from "@/lib/stores";

const API_BASE = getApiBase();

function apiUrl(path: string) {
  return `${API_BASE}/api${path}`;
}

const STORE_SESSION_KEY = "store_portal_session";

function saveSession(storeCode: string, storeName: string, token: string) {
  sessionStorage.setItem(STORE_SESSION_KEY, JSON.stringify({ storeCode, storeName, token, ts: Date.now() }));
}

function loadSession(): { storeCode: string; storeName: string; token: string } | null {
  try {
    const raw = sessionStorage.getItem(STORE_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const ageMs = Date.now() - (parsed.ts ?? 0);
    if (ageMs > 8 * 60 * 60 * 1000) { sessionStorage.removeItem(STORE_SESSION_KEY); return null; }
    if (parsed.storeCode && parsed.token) return parsed;
    return null;
  } catch { return null; }
}

function clearSession() {
  sessionStorage.removeItem(STORE_SESSION_KEY);
}

const WR_STORES = STORES.filter(s => s.region === "WR");
const CR_STORES = STORES.filter(s => s.region === "CR");
const NR_STORES = STORES.filter(s => s.region === "NR");

export default function StorePortalPage() {
  const { toast } = useToast();

  const [session, setSession] = useState<{ storeCode: string; storeName: string; token: string } | null>(() => loadSession());

  const [storeCode, setStoreCode] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState("");

  const [sohMeta, setSohMeta] = useState<{ uploadedAt: string | null; count: number | null }>({ uploadedAt: null, count: null });
  const [metaLoaded, setMetaLoaded] = useState(false);

  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const [showChangePassword, setShowChangePassword] = useState(false);
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [changePwLoading, setChangePwLoading] = useState(false);

  const [showReset, setShowReset] = useState(false);
  const [resetLoading, setResetLoading] = useState(false);

  const fetchMeta = useCallback(async (code: string, token: string) => {
    try {
      const r = await fetch(apiUrl(`/store-portal/soh-meta?storeCode=${code}`), {
        headers: { "x-store-token": token },
      });
      if (r.ok) {
        const data = await r.json();
        setSohMeta({ uploadedAt: data.uploadedAt ?? null, count: data.count ?? null });
      }
    } catch {}
    setMetaLoaded(true);
  }, []);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    if (!storeCode) { setLoginError("Please select your store."); return; }
    if (!password) { setLoginError("Please enter your password."); return; }
    setLoginLoading(true);
    setLoginError("");
    try {
      const r = await fetch(apiUrl("/store-portal/login"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storeCode, password }),
      });
      const data = await r.json();
      if (!r.ok) { setLoginError(data.error ?? "Login failed"); setLoginLoading(false); return; }
      const store = STORES.find(s => s.code === storeCode);
      const sess = { storeCode, storeName: store?.name ?? storeCode, token: data.token };
      saveSession(sess.storeCode, sess.storeName, sess.token);
      setSession(sess);
      setSohMeta({ uploadedAt: data.uploadedAt ?? null, count: data.count ?? null });
      setMetaLoaded(true);
      setPassword("");
    } catch {
      setLoginError("Network error. Please try again.");
    }
    setLoginLoading(false);
  }

  function handleLogout() {
    clearSession();
    setSession(null);
    setMetaLoaded(false);
    setSohMeta({ uploadedAt: null, count: null });
    setStoreCode("");
    setPassword("");
  }

  async function processFile(file: File) {
    if (!session) return;
    if (!file.name.match(/\.(xlsx|xls|csv)$/i)) {
      toast({ title: "Invalid file", description: "Please upload an Excel or CSV file.", variant: "destructive" });
      return;
    }
    setUploading(true);
    try {
      const raw = await parseSohFile(file);
      if (!raw || raw.length === 0) {
        toast({ title: "Empty file", description: "No data rows found in the file.", variant: "destructive" });
        setUploading(false);
        return;
      }
      const { byBarcode, byItem } = buildSohMaps(raw);
      const rows = raw.map((r: any) => ({
        barcode: r["Barcode"] ?? r["barcode"] ?? r["EAN"] ?? r["ean"] ?? "",
        itemNumber: r["Item No."] ?? r["Item No"] ?? r["item_number"] ?? r["No."] ?? "",
        qty: Number(r["Qty"] ?? r["qty"] ?? r["SOH"] ?? r["soh"] ?? r["Quantity"] ?? r["quantity"] ?? 0),
      })).filter((r: any) => r.qty > 0 && (r.barcode || r.itemNumber));

      if (rows.length === 0) {
        toast({ title: "No valid rows", description: "Could not find qty/barcode data in the file.", variant: "destructive" });
        setUploading(false);
        return;
      }

      const r2 = await fetch(apiUrl("/store-portal/upload-soh"), {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-store-token": session.token },
        body: JSON.stringify({ rows }),
      });
      const result = await r2.json();
      if (!r2.ok) {
        if (r2.status === 401) {
          toast({ title: "Session expired", description: "Please log in again.", variant: "destructive" });
          handleLogout();
        } else {
          toast({ title: "Upload failed", description: result.error ?? "Unknown error", variant: "destructive" });
        }
        setUploading(false);
        return;
      }
      setSohMeta({ uploadedAt: result.uploadedAt, count: result.count });
      toast({ title: "SOH uploaded successfully", description: `${result.count} rows saved for ${session.storeName}.` });
    } catch (err) {
      toast({ title: "Upload error", description: String(err), variant: "destructive" });
    }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    if (!session) return;
    if (newPw !== confirmPw) { toast({ title: "Passwords do not match", variant: "destructive" }); return; }
    if (newPw.length < 6) { toast({ title: "Password too short", description: "Must be at least 6 characters.", variant: "destructive" }); return; }
    setChangePwLoading(true);
    try {
      const r = await fetch(apiUrl("/store-portal/change-password"), {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-store-token": session.token },
        body: JSON.stringify({ currentPassword: currentPw, newPassword: newPw }),
      });
      const data = await r.json();
      if (!r.ok) { toast({ title: "Failed", description: data.error ?? "Error", variant: "destructive" }); setChangePwLoading(false); return; }
      toast({ title: "Password changed", description: "Your new password is now active." });
      setCurrentPw(""); setNewPw(""); setConfirmPw("");
      setShowChangePassword(false);
    } catch { toast({ title: "Network error", variant: "destructive" }); }
    setChangePwLoading(false);
  }

  async function handleResetPassword() {
    if (!storeCode && !session?.storeCode) { toast({ title: "Select a store first", variant: "destructive" }); return; }
    const code = session?.storeCode ?? storeCode;
    setResetLoading(true);
    try {
      const r = await fetch(apiUrl("/store-portal/reset-password"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storeCode: code }),
      });
      const data = await r.json();
      if (!r.ok) { toast({ title: "Reset failed", description: data.error, variant: "destructive" }); setResetLoading(false); return; }
      toast({ title: "Password reset", description: `Password is now: Newworld123` });
      setShowReset(false);
      if (session) handleLogout();
    } catch { toast({ title: "Network error", variant: "destructive" }); }
    setResetLoading(false);
  }

  if (!session) {
    return (
      <div className="min-h-screen bg-zinc-50 flex items-center justify-center p-4">
        <div className="w-full max-w-md space-y-4">
          <div className="text-center mb-6">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-green-600 mb-3">
              <Database className="w-7 h-7 text-white" />
            </div>
            <h1 className="text-2xl font-bold text-zinc-900">Store SOH Portal</h1>
            <p className="text-sm text-zinc-500 mt-1">Upload your store's System-on-Hand data</p>
          </div>

          <Card className="border-zinc-200 shadow-sm">
            <CardContent className="pt-6">
              <form onSubmit={handleLogin} className="space-y-4">
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Store</Label>
                  <select
                    value={storeCode}
                    onChange={e => { setStoreCode(e.target.value); setLoginError(""); }}
                    className="w-full h-10 rounded-md border border-zinc-200 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-green-500"
                  >
                    <option value="">— Select your store —</option>
                    <optgroup label="Western Region">
                      {WR_STORES.map(s => <option key={s.code} value={s.code}>{s.name}</option>)}
                    </optgroup>
                    <optgroup label="Central Region">
                      {CR_STORES.map(s => <option key={s.code} value={s.code}>{s.name}</option>)}
                    </optgroup>
                    <optgroup label="Northern Region">
                      {NR_STORES.map(s => <option key={s.code} value={s.code}>{s.name}</option>)}
                    </optgroup>
                  </select>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Password</Label>
                  <div className="relative">
                    <Input
                      type={showPw ? "text" : "password"}
                      value={password}
                      onChange={e => { setPassword(e.target.value); setLoginError(""); }}
                      placeholder="Enter password"
                      className="pr-10"
                      autoComplete="current-password"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPw(v => !v)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600"
                      tabIndex={-1}
                    >
                      {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                {loginError && (
                  <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    {loginError}
                  </div>
                )}

                <Button
                  type="submit"
                  disabled={loginLoading}
                  className="w-full bg-green-600 hover:bg-green-700 text-white font-semibold"
                >
                  {loginLoading ? "Logging in…" : "Log In"}
                </Button>
              </form>
            </CardContent>
          </Card>

          <div className="text-center">
            {!showReset ? (
              <button
                onClick={() => setShowReset(true)}
                className="text-xs text-zinc-400 hover:text-zinc-600 underline underline-offset-2"
              >
                Forgot password? Reset to default
              </button>
            ) : (
              <Card className="border-amber-200 bg-amber-50">
                <CardContent className="pt-4 pb-4 space-y-3">
                  <p className="text-sm text-amber-800 font-medium">Reset password for selected store?</p>
                  <p className="text-xs text-amber-700">
                    This will reset <strong>{storeCode ? STORES.find(s => s.code === storeCode)?.name ?? storeCode : "the selected store"}</strong>'s password to <code className="bg-amber-100 px-1 rounded">Newworld123</code>.
                    {!storeCode && " Please select your store above first."}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      onClick={handleResetPassword}
                      disabled={resetLoading || !storeCode}
                      className="bg-amber-600 hover:bg-amber-700 text-white flex-1"
                    >
                      {resetLoading ? "Resetting…" : "Reset Password"}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setShowReset(false)} className="flex-1">
                      Cancel
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-50 p-4">
      <div className="max-w-lg mx-auto space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold text-zinc-900">{session.storeName}</h1>
            <p className="text-xs text-zinc-500">Store SOH Portal · {session.storeCode}</p>
          </div>
          <Button size="sm" variant="outline" onClick={handleLogout} className="gap-1.5 text-zinc-600">
            <LogOut className="w-3.5 h-3.5" />
            Log out
          </Button>
        </div>

        {/* Last upload status */}
        <Card className="border-zinc-200 shadow-sm">
          <CardHeader className="pb-2 pt-4 px-4">
            <CardTitle className="text-sm font-semibold text-zinc-700 flex items-center gap-2">
              <Database className="w-4 h-4 text-green-600" />
              SOH Upload Status
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            {sohMeta.uploadedAt ? (
              <div className="flex items-center gap-2 text-sm">
                <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" />
                <div>
                  <span className="font-medium text-zinc-800">Last upload: </span>
                  <span className="text-zinc-600">
                    {format(parseISO(sohMeta.uploadedAt), "dd MMM yyyy, h:mm a")}
                  </span>
                  {sohMeta.count != null && (
                    <span className="ml-2 text-xs text-zinc-400">({sohMeta.count.toLocaleString()} rows)</span>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-sm text-zinc-500">
                <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
                No SOH data uploaded yet for this store.
              </div>
            )}
          </CardContent>
        </Card>

        {/* SOH Upload */}
        <Card className="border-zinc-200 shadow-sm">
          <CardHeader className="pb-2 pt-4 px-4">
            <CardTitle className="text-sm font-semibold text-zinc-700 flex items-center gap-2">
              <Upload className="w-4 h-4 text-green-600" />
              Upload SOH File
            </CardTitle>
            <CardDescription className="text-xs text-zinc-400">
              Upload your store's System-on-Hand Excel or CSV file.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <div
              onDragOver={e => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={e => {
                e.preventDefault();
                setDragOver(false);
                const file = e.dataTransfer.files[0];
                if (file) processFile(file);
              }}
              onClick={() => fileRef.current?.click()}
              className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${
                dragOver
                  ? "border-green-400 bg-green-50"
                  : "border-zinc-200 hover:border-green-300 hover:bg-green-50/40"
              }`}
            >
              <input
                ref={fileRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) processFile(f); }}
              />
              {uploading ? (
                <div className="space-y-2">
                  <div className="w-8 h-8 border-2 border-green-500 border-t-transparent rounded-full animate-spin mx-auto" />
                  <p className="text-sm text-green-700 font-medium">Uploading…</p>
                </div>
              ) : (
                <div className="space-y-2">
                  <Upload className="w-8 h-8 text-zinc-300 mx-auto" />
                  <p className="text-sm font-medium text-zinc-600">Drop file here or click to browse</p>
                  <p className="text-xs text-zinc-400">.xlsx, .xls, .csv accepted</p>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Change Password */}
        <Card className="border-zinc-200 shadow-sm">
          <CardHeader className="pb-2 pt-4 px-4">
            <button
              onClick={() => setShowChangePassword(v => !v)}
              className="flex items-center gap-2 w-full text-left"
            >
              <KeyRound className="w-4 h-4 text-zinc-500" />
              <CardTitle className="text-sm font-semibold text-zinc-700 flex-1">Change Password</CardTitle>
              <span className="text-xs text-zinc-400">{showChangePassword ? "▲" : "▼"}</span>
            </button>
          </CardHeader>
          {showChangePassword && (
            <CardContent className="px-4 pb-4">
              <form onSubmit={handleChangePassword} className="space-y-3">
                <div className="space-y-1">
                  <Label className="text-xs text-zinc-500">Current Password</Label>
                  <Input
                    type="password"
                    value={currentPw}
                    onChange={e => setCurrentPw(e.target.value)}
                    placeholder="Current password"
                    className="h-9 text-sm"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-zinc-500">New Password</Label>
                  <Input
                    type="password"
                    value={newPw}
                    onChange={e => setNewPw(e.target.value)}
                    placeholder="New password (min 6 characters)"
                    className="h-9 text-sm"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-zinc-500">Confirm New Password</Label>
                  <Input
                    type="password"
                    value={confirmPw}
                    onChange={e => setConfirmPw(e.target.value)}
                    placeholder="Confirm new password"
                    className="h-9 text-sm"
                  />
                </div>
                <Button
                  type="submit"
                  disabled={changePwLoading || !currentPw || !newPw || !confirmPw}
                  className="w-full bg-zinc-800 hover:bg-zinc-700 text-white"
                  size="sm"
                >
                  {changePwLoading ? "Saving…" : "Save New Password"}
                </Button>
              </form>
            </CardContent>
          )}
        </Card>

        {/* Reset password (while logged in) */}
        <div className="text-center">
          {!showReset ? (
            <button
              onClick={() => setShowReset(true)}
              className="text-xs text-zinc-400 hover:text-zinc-600 underline underline-offset-2"
            >
              Reset password back to default (Newworld123)
            </button>
          ) : (
            <Card className="border-amber-200 bg-amber-50">
              <CardContent className="pt-4 pb-4 space-y-3">
                <p className="text-sm text-amber-800 font-medium">Reset password for {session.storeName}?</p>
                <p className="text-xs text-amber-700">
                  Password will be reset to <code className="bg-amber-100 px-1 rounded">Newworld123</code>. You'll be logged out.
                </p>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    onClick={handleResetPassword}
                    disabled={resetLoading}
                    className="bg-amber-600 hover:bg-amber-700 text-white flex-1"
                  >
                    {resetLoading ? "Resetting…" : "Reset Password"}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setShowReset(false)} className="flex-1">
                    Cancel
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
