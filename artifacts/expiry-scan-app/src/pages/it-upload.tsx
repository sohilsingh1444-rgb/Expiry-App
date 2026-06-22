import { useState, useRef } from "react";
import { parseBarcodeMaster, parseRrpFile, parseSpecialsFile, parseSohFile } from "@/lib/xlsx";
import { buildBarcodeMaps } from "@/hooks/use-barcode-master";
import { buildRrpMap, buildSpecialsMap } from "@/lib/xlsx";
import { buildSohMaps } from "@/hooks/use-soh-data";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { FileSpreadsheet, Tag, Percent, Database, Upload, LogOut, ShieldCheck } from "lucide-react";
import { format, parseISO } from "date-fns";
import { getApiBase } from "@/lib/api-base";

function apiUrl(path: string) {
  return `${getApiBase()}/api${path}`;
}

type MasterMeta = { uploadedAt: string | null; count: number };

export default function ItUploadPage() {
  const { toast } = useToast();
  const [password, setPassword] = useState("");
  const [authed, setAuthed] = useState(false);
  const [authError, setAuthError] = useState("");
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  const [bmMeta, setBmMeta] = useState<MasterMeta>({ uploadedAt: null, count: 0 });
  const [bmUploading, setBmUploading] = useState(false);
  const [rrpMeta, setRrpMeta] = useState<MasterMeta>({ uploadedAt: null, count: 0 });
  const [rrpUploading, setRrpUploading] = useState(false);
  const [specialsMeta, setSpecialsMeta] = useState<MasterMeta>({ uploadedAt: null, count: 0 });
  const [specialsUploading, setSpecialsUploading] = useState(false);
  const [sohMeta, setSohMeta] = useState<MasterMeta>({ uploadedAt: null, count: 0 });
  const [sohUploading, setSohUploading] = useState(false);
  const bmFileRef = useRef<HTMLInputElement>(null);
  const rrpFileRef = useRef<HTMLInputElement>(null);
  const specialsFileRef = useRef<HTMLInputElement>(null);
  const sohFileRef = useRef<HTMLInputElement>(null);

  const storedPassword = () => sessionStorage.getItem("it_pw") ?? "";

  async function verifyAndLoad(pw: string) {
    setIsLoggingIn(true);
    setAuthError("");
    try {
      const res = await fetch(apiUrl("/admin/it-verify"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw }),
      });
      if (!res.ok) {
        setAuthError("Incorrect password. Please try again.");
        sessionStorage.removeItem("it_pw");
        setAuthed(false);
        return;
      }
      sessionStorage.setItem("it_pw", pw);
      setAuthed(true);
      await loadMeta();
    } catch {
      setAuthError("Connection error. Please try again.");
    } finally {
      setIsLoggingIn(false);
    }
  }

  async function loadMeta() {
    try {
      const [bmRes, rrpRes, specRes, sohRes] = await Promise.all([
        fetch(apiUrl("/barcode-master/meta")),
        fetch(apiUrl("/rrp-data/meta")),
        fetch(apiUrl("/specials-data/meta")),
        fetch(apiUrl("/soh-data/meta")),
      ]);
      if (bmRes.ok) setBmMeta(await bmRes.json());
      if (rrpRes.ok) setRrpMeta(await rrpRes.json());
      if (specRes.ok) setSpecialsMeta(await specRes.json());
      if (sohRes.ok) setSohMeta(await sohRes.json());
    } catch {}
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    await verifyAndLoad(password);
  }

  function handleLogout() {
    sessionStorage.removeItem("it_pw");
    setAuthed(false);
    setPassword("");
  }

  async function gzipBase64(obj: unknown): Promise<string> {
    const jsonBytes = new TextEncoder().encode(JSON.stringify(obj));
    const cs = new CompressionStream("gzip");
    const writer = cs.writable.getWriter();
    writer.write(jsonBytes);
    writer.close();
    const chunks: Uint8Array[] = [];
    const reader = cs.readable.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const merged = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let off = 0;
    for (const c of chunks) { merged.set(c, off); off += c.length; }
    let bin = "";
    for (let i = 0; i < merged.length; i++) bin += String.fromCharCode(merged[i]);
    return btoa(bin);
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
      const compressed = await gzipBase64({ map, count });
      const res = await fetch(apiUrl("/admin/barcode-master"), {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-password": pw },
        body: JSON.stringify({ compressed }),
      });
      if (res.ok) {
        const data = await res.json();
        setBmMeta({ uploadedAt: data.uploadedAt, count: data.count });
        toast({ title: "Barcode Master uploaded", description: `${Number(data.count).toLocaleString()} items stored. All devices will auto-load on next open.` });
      } else {
        const text = await res.text();
        let errMsg = `Upload failed (${res.status})`;
        if (res.status === 413) errMsg = "File is too large. Try exporting only essential columns.";
        else { try { errMsg = (JSON.parse(text) as { error?: string }).error ?? errMsg; } catch { /* non-JSON */ } }
        toast({ title: "Upload failed", description: errMsg, variant: "destructive" });
      }
    } catch (err) {
      toast({ title: "Upload error", description: err instanceof Error ? err.message : "Failed to read or upload file.", variant: "destructive" });
    } finally {
      setBmUploading(false);
    }
  }

  async function handleRrpUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    const pw = storedPassword();
    setRrpUploading(true);
    try {
      const rows = await parseRrpFile(file);
      if (!rows.length) {
        toast({ title: "Empty file", description: "No rows found in the file.", variant: "destructive" });
        return;
      }
      const { byItem, count } = buildRrpMap(rows);
      if (Object.keys(byItem).length === 0) {
        const detectedCols = Object.keys(rows[0] ?? {}).join(", ") || "none";
        toast({
          title: "No RRP data found",
          description: `Parser found ${rows.length} rows but 0 valid entries. Columns detected: ${detectedCols}`,
          variant: "destructive",
        });
        return;
      }
      const res = await fetch(apiUrl("/admin/rrp-data"), {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-password": pw },
        body: JSON.stringify({ byItem, count }),
      });
      if (res.ok) {
        const data = await res.json();
        setRrpMeta({ uploadedAt: data.uploadedAt, count: data.count });
        toast({ title: "RRP Data uploaded", description: `${Number(data.count).toLocaleString()} items stored.` });
      } else {
        const text = await res.text();
        let errMsg = `Upload failed (${res.status})`;
        if (res.status === 413) errMsg = "File is too large. Try exporting only essential columns.";
        else { try { errMsg = (JSON.parse(text) as { error?: string }).error ?? errMsg; } catch { /* non-JSON */ } }
        toast({ title: "Upload failed", description: errMsg, variant: "destructive" });
      }
    } catch (err) {
      toast({ title: "Upload error", description: err instanceof Error ? err.message : "Failed to read or upload file.", variant: "destructive" });
    } finally {
      setRrpUploading(false);
    }
  }

  async function handleSpecialsUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    const pw = storedPassword();
    setSpecialsUploading(true);
    try {
      const rows = await parseSpecialsFile(file);
      if (!rows.length) {
        toast({ title: "Empty file", description: "No rows found in the file.", variant: "destructive" });
        return;
      }
      const { byItem, rrpByItem, count } = buildSpecialsMap(rows);

      // Upload specials + RRP in parallel (RRP comes from Standard Price Including VAT in same file)
      const [specRes, rrpRes] = await Promise.all([
        fetch(apiUrl("/admin/specials-data"), {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-admin-password": pw },
          body: JSON.stringify({ byItem, count }),
        }),
        Object.keys(rrpByItem).length > 0
          ? fetch(apiUrl("/admin/rrp-data"), {
              method: "POST",
              headers: { "Content-Type": "application/json", "x-admin-password": pw },
              body: JSON.stringify({ byItem: rrpByItem, count: Object.keys(rrpByItem).length }),
            })
          : Promise.resolve(null),
      ]);

      if (specRes.ok) {
        const data = await specRes.json();
        setSpecialsMeta({ uploadedAt: data.uploadedAt, count: data.count });
        if (rrpRes?.ok) {
          const rrpData = await rrpRes.json();
          setRrpMeta({ uploadedAt: rrpData.uploadedAt, count: rrpData.count });
          toast({ title: "Specials + RRP uploaded", description: `${Number(data.count).toLocaleString()} specials and ${Number(rrpData.count).toLocaleString()} RRP items stored.` });
        } else {
          toast({ title: "Specials Data uploaded", description: `${Number(data.count).toLocaleString()} items stored.` });
        }
      } else {
        const text = await specRes.text();
        let errMsg = `Upload failed (${specRes.status})`;
        if (specRes.status === 413) errMsg = "File is too large. Try exporting only essential columns.";
        else { try { errMsg = (JSON.parse(text) as { error?: string }).error ?? errMsg; } catch { /* non-JSON */ } }
        toast({ title: "Upload failed", description: errMsg, variant: "destructive" });
      }
    } catch (err) {
      toast({ title: "Upload error", description: err instanceof Error ? err.message : "Failed to read or upload file.", variant: "destructive" });
    } finally {
      setSpecialsUploading(false);
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
      const { byBarcode, byItem, byStore, byRegion, count } = buildSohMaps(rows);
      const res = await fetch(apiUrl("/admin/soh-data"), {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-password": pw },
        body: JSON.stringify({ byBarcode, byItem, byStore, byRegion, count }),
      });
      if (res.ok) {
        const data = await res.json();
        setSohMeta({ uploadedAt: data.uploadedAt, count: data.count });
        toast({ title: "SOH Data uploaded", description: `${Number(data.count).toLocaleString()} items stored. All devices will auto-load on next open.` });
      } else {
        const text = await res.text();
        let errMsg = `Upload failed (${res.status})`;
        if (res.status === 413) errMsg = "File is too large. Try exporting only essential columns.";
        else { try { errMsg = (JSON.parse(text) as { error?: string }).error ?? errMsg; } catch { /* non-JSON */ } }
        toast({ title: "Upload failed", description: errMsg, variant: "destructive" });
      }
    } catch (err) {
      toast({ title: "Upload error", description: err instanceof Error ? err.message : "Failed to read or upload file.", variant: "destructive" });
    } finally {
      setSohUploading(false);
    }
  }

  if (!authed) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
        <Card className="w-full max-w-sm">
          <CardHeader className="text-center">
            <div className="flex justify-center mb-2">
              <ShieldCheck className="w-8 h-8 text-blue-600" />
            </div>
            <CardTitle>IT Upload Portal</CardTitle>
            <CardDescription>Sign in to upload master data files</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleLogin} className="space-y-4">
              <div className="space-y-1">
                <Label htmlFor="it-pw">Password</Label>
                <Input
                  id="it-pw"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter IT upload password"
                  autoFocus
                />
              </div>
              {authError && <p className="text-sm text-red-600">{authError}</p>}
              <Button type="submit" className="w-full" disabled={isLoggingIn || !password}>
                {isLoggingIn ? "Signing in…" : "Sign In"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-5 h-5 text-blue-600" />
          <span className="font-semibold text-gray-800">IT Upload Portal</span>
        </div>
        <Button variant="ghost" size="sm" onClick={handleLogout} className="gap-1 text-gray-500">
          <LogOut className="w-4 h-4" />
          Sign out
        </Button>
      </header>

      <main className="max-w-lg mx-auto px-4 py-8 space-y-4">
        <p className="text-sm text-gray-500 text-center">
          Upload the latest files below. All store devices will automatically load the new data on their next page open.
        </p>

        {/* 1. Items / Barcode Master */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <FileSpreadsheet className="w-4 h-4 text-blue-600" />
              Items File (Barcode Master)
            </CardTitle>
            <CardDescription className="text-xs text-gray-500">Barcode → item number → description lookup</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {bmMeta.count > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Current items</span>
                <span className="font-medium">{bmMeta.count.toLocaleString()}</span>
              </div>
            )}
            {bmMeta.uploadedAt ? (
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Last uploaded</span>
                <span className="text-gray-700">{format(parseISO(bmMeta.uploadedAt), "d MMM yyyy, h:mm a")}</span>
              </div>
            ) : (
              <p className="text-sm text-amber-600">No file uploaded yet.</p>
            )}
            <input ref={bmFileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleBarcodeMasterUpload} />
            <Button className="w-full gap-2" onClick={() => bmFileRef.current?.click()} disabled={bmUploading}>
              <Upload className="w-4 h-4" />
              {bmUploading ? "Uploading…" : bmMeta.count > 0 ? "Replace file" : "Upload file"}
            </Button>
          </CardContent>
        </Card>

        {/* 2. RRP Data */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Tag className="w-4 h-4 text-emerald-600" />
              RRP Data
            </CardTitle>
            <CardDescription className="text-xs text-gray-500">Customer Price Group file — columns: Sales Code (CR/NR/WR), Item No., Unit Price Including VAT</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {rrpMeta.count > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Current items</span>
                <span className="font-medium">{rrpMeta.count.toLocaleString()}</span>
              </div>
            )}
            {rrpMeta.uploadedAt ? (
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Last uploaded</span>
                <span className="text-gray-700">{format(parseISO(rrpMeta.uploadedAt), "d MMM yyyy, h:mm a")}</span>
              </div>
            ) : (
              <p className="text-sm text-amber-600">No file uploaded yet.</p>
            )}
            <input ref={rrpFileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleRrpUpload} />
            <Button className="w-full gap-2" onClick={() => rrpFileRef.current?.click()} disabled={rrpUploading}>
              <Upload className="w-4 h-4" />
              {rrpUploading ? "Uploading…" : rrpMeta.count > 0 ? "Replace file" : "Upload file"}
            </Button>
          </CardContent>
        </Card>

        {/* 3. Specials Data */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Percent className="w-4 h-4 text-orange-500" />
              Specials / Offers Data
            </CardTitle>
            <CardDescription className="text-xs text-gray-500">Deal prices by region from the Offers export (suffix -CR / -NR / -WR)</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {specialsMeta.count > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Current items</span>
                <span className="font-medium">{specialsMeta.count.toLocaleString()}</span>
              </div>
            )}
            {specialsMeta.uploadedAt ? (
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Last uploaded</span>
                <span className="text-gray-700">{format(parseISO(specialsMeta.uploadedAt), "d MMM yyyy, h:mm a")}</span>
              </div>
            ) : (
              <p className="text-sm text-amber-600">No file uploaded yet.</p>
            )}
            <input ref={specialsFileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleSpecialsUpload} />
            <Button className="w-full gap-2" onClick={() => specialsFileRef.current?.click()} disabled={specialsUploading}>
              <Upload className="w-4 h-4" />
              {specialsUploading ? "Uploading…" : specialsMeta.count > 0 ? "Replace file" : "Upload file"}
            </Button>
          </CardContent>
        </Card>

        {/* 4. SOH Data */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Database className="w-4 h-4 text-purple-500" />
              System SOH Data
            </CardTitle>
            <CardDescription className="text-xs text-gray-500">Stock on hand quantities by store</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {sohMeta.count > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Current items</span>
                <span className="font-medium">{sohMeta.count.toLocaleString()}</span>
              </div>
            )}
            {sohMeta.uploadedAt ? (
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Last uploaded</span>
                <span className="text-gray-700">{format(parseISO(sohMeta.uploadedAt), "d MMM yyyy, h:mm a")}</span>
              </div>
            ) : (
              <p className="text-sm text-amber-600">No file uploaded yet.</p>
            )}
            <input ref={sohFileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleSohUpload} />
            <Button className="w-full gap-2" onClick={() => sohFileRef.current?.click()} disabled={sohUploading}>
              <Upload className="w-4 h-4" />
              {sohUploading ? "Uploading…" : sohMeta.count > 0 ? "Replace file" : "Upload file"}
            </Button>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
