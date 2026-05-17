const DB_NAME = "expiry-scan-offline";
const STORE_NAME = "pending-scans";
const DB_VERSION = 1;

export type PendingScan = {
  id: string;
  data: Record<string, unknown>;
  queuedAt: number;
};

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function enqueueOfflineScan(data: Record<string, unknown>): Promise<string> {
  const id = `offline-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).add({ id, data, queuedAt: Date.now() } satisfies PendingScan);
    tx.oncomplete = () => resolve(id);
    tx.onerror = () => reject(tx.error);
  });
}

export async function getPendingScans(): Promise<PendingScan[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result as PendingScan[]);
    req.onerror = () => reject(req.error);
  });
}

export async function removePendingScan(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getPendingCount(): Promise<number> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
