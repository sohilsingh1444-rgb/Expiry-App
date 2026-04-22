import { useState, useEffect } from "react";
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
import { Trash2, Settings, LogOut, ShieldCheck } from "lucide-react";
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

type Settings = {
  urgentDays: number;
  nearExpiryDays: number;
};

export default function AdminPage() {
  const { toast } = useToast();
  const [password, setPassword] = useState("");
  const [authed, setAuthed] = useState(false);
  const [authError, setAuthError] = useState("");
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  const [sessions, setSessions] = useState<Session[]>([]);
  const [isLoadingSessions, setIsLoadingSessions] = useState(false);

  const [settings, setSettings] = useState<Settings>({ urgentDays: 2, nearExpiryDays: 15 });
  const [urgentInput, setUrgentInput] = useState("2");
  const [nearExpiryInput, setNearExpiryInput] = useState("15");
  const [isSavingSettings, setIsSavingSettings] = useState(false);

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
      await Promise.all([loadSessions(pw), loadSettings()]);
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
      const data: Settings = await res.json();
      setSettings(data);
      setUrgentInput(String(data.urgentDays));
      setNearExpiryInput(String(data.nearExpiryDays));
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
        const data: Settings = await res.json();
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

  if (!authed) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
        <Card className="w-full max-w-sm bg-zinc-900 border-zinc-800">
          <CardHeader className="text-center">
            <div className="flex justify-center mb-2">
              <ShieldCheck className="h-8 w-8 text-amber-500" />
            </div>
            <CardTitle className="text-white text-xl">Admin Panel</CardTitle>
            <CardDescription className="text-zinc-400">Enter your admin password to continue</CardDescription>
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
          <h1 className="text-lg font-semibold tracking-tight">Admin Panel</h1>
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

      <main className="max-w-4xl mx-auto px-4 py-8 space-y-8">

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
                  <Label className="text-zinc-300">
                    Urgent (days left &le; X)
                  </Label>
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
                  <Label className="text-zinc-300">
                    Near Expiry (days left &le; X)
                  </Label>
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
    </div>
  );
}
