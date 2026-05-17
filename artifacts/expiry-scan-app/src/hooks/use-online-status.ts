import { useState, useEffect, useCallback, useRef } from "react";
import { getPendingScans, removePendingScan, getPendingCount } from "@/lib/offline-queue";
import { getApiBase } from "@/lib/api-base";

export function useOnlineStatus() {
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [pendingCount, setPendingCount] = useState(0);
  const [isSyncing, setIsSyncing] = useState(false);
  const syncingRef = useRef(false);

  const refreshPendingCount = useCallback(async () => {
    const count = await getPendingCount();
    setPendingCount(count);
  }, []);

  const syncPendingScans = useCallback(async () => {
    if (syncingRef.current) return;
    const pending = await getPendingScans();
    if (pending.length === 0) return;

    syncingRef.current = true;
    setIsSyncing(true);
    const base = getApiBase();

    for (const scan of pending) {
      try {
        const res = await fetch(`${base}/expiry-scans`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(scan.data),
        });
        if (res.ok) {
          await removePendingScan(scan.id);
        }
      } catch {
        break;
      }
    }

    syncingRef.current = false;
    setIsSyncing(false);
    await refreshPendingCount();
  }, [refreshPendingCount]);

  useEffect(() => {
    refreshPendingCount();

    const handleOnline = () => {
      setIsOnline(true);
      syncPendingScans();
    };
    const handleOffline = () => setIsOnline(false);

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [syncPendingScans, refreshPendingCount]);

  return { isOnline, pendingCount, isSyncing, refreshPendingCount, syncPendingScans };
}
