import { useOnlineStatus } from "@/hooks/use-online-status";
import { WifiOff, RefreshCw, CheckCircle2 } from "lucide-react";
import { useEffect, useState } from "react";

export function OfflineBanner() {
  const { isOnline, pendingCount, isSyncing } = useOnlineStatus();
  const [justSynced, setJustSynced] = useState(false);
  const prevPending = useState(pendingCount)[0];

  useEffect(() => {
    if (isOnline && pendingCount === 0 && prevPending > 0) {
      setJustSynced(true);
      const t = setTimeout(() => setJustSynced(false), 3000);
      return () => clearTimeout(t);
    }
  }, [isOnline, pendingCount, prevPending]);

  if (isOnline && pendingCount === 0 && !justSynced) return null;

  if (justSynced) {
    return (
      <div className="fixed top-0 left-0 right-0 z-50 flex items-center justify-center gap-2 bg-green-600 text-white text-sm font-medium py-2 px-4 shadow-md">
        <CheckCircle2 className="h-4 w-4" />
        All offline scans synced successfully
      </div>
    );
  }

  if (!isOnline) {
    return (
      <div className="fixed top-0 left-0 right-0 z-50 flex items-center justify-center gap-2 bg-amber-500 text-white text-sm font-medium py-2 px-4 shadow-md">
        <WifiOff className="h-4 w-4 shrink-0" />
        <span>
          You are offline — scans are being saved locally
          {pendingCount > 0 && ` (${pendingCount} queued)`}
        </span>
      </div>
    );
  }

  if (isSyncing || pendingCount > 0) {
    return (
      <div className="fixed top-0 left-0 right-0 z-50 flex items-center justify-center gap-2 bg-blue-600 text-white text-sm font-medium py-2 px-4 shadow-md">
        <RefreshCw className="h-4 w-4 animate-spin shrink-0" />
        <span>
          {isSyncing
            ? `Syncing ${pendingCount} offline scan${pendingCount !== 1 ? "s" : ""}…`
            : `${pendingCount} scan${pendingCount !== 1 ? "s" : ""} pending sync`}
        </span>
      </div>
    );
  }

  return null;
}
