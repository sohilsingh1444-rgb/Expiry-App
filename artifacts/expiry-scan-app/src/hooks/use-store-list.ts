import { useState, useEffect } from "react";
import { STORES } from "@/lib/stores";
import { getApiBase } from "@/lib/api-base";

export type StoreListItem = {
  code: string;
  name: string;
  region: "WR" | "CR" | "NR";
};

export function useStoreList() {
  const [stores, setStores] = useState<StoreListItem[]>(
    STORES.map(s => ({ code: s.code, name: s.name, region: s.region as "WR" | "CR" | "NR" }))
  );
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch(`${getApiBase()}/api/stores`)
      .then(r => r.ok ? r.json() : null)
      .then((data: StoreListItem[] | null) => {
        if (!cancelled && data && Array.isArray(data) && data.length > 0) {
          setStores(data);
        }
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setIsLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const getStoreByCode = (code: string) =>
    stores.find(s => s.code.toLowerCase() === code.toLowerCase());

  const getStoreRegion = (code: string) =>
    getStoreByCode(code)?.region;

  return { stores, isLoading, getStoreByCode, getStoreRegion };
}
