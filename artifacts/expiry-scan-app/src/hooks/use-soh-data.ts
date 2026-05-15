import { useState, useEffect, useCallback } from 'react';
import { getApiBase } from '@/lib/api-base';

const SOH_STORAGE_KEY = 'expiry-scan-soh-data';
const SOH_ITEM_STORAGE_KEY = 'expiry-scan-soh-data-by-item';
const SOH_API_TS_KEY = 'expiry-scan-soh-api-ts';

export function buildSohMaps(rows: any[]): {
  byBarcode: Record<string, number>;
  byItem: Record<string, number>;
  count: number;
} {
  if (!rows.length) return { byBarcode: {}, byItem: {}, count: 0 };

  const mapByBarcode: Record<string, number> = {};
  const mapByItem: Record<string, number> = {};

  const firstRow = rows[0];
  const keys = Object.keys(firstRow);

  const findCol = (possibleNames: string[]) =>
    keys.find(k =>
      possibleNames.some(pn =>
        k.toLowerCase().replace(/[\s_\-]/g, '').includes(pn.toLowerCase().replace(/[\s_\-]/g, ''))
      )
    );

  const barcodeCol = findCol(['barcode', 'upc', 'ean', 'gtin', 'code']);
  const itemCol    = findCol(['itemno', 'itemnum', 'itemnumber', 'itemcode', 'article', 'sku', 'item']);
  const sohCol     = findCol(['soh', 'stockonhand', 'stock', 'onhand', 'available', 'totalqty',
                              'totalstock', 'balanceqty', 'qtyonhand', 'availqty', 'quantity', 'qty',
                              'inventory', 'inv', 'inven', 'onhandqty', 'physicalinv']);

  const identifierCols = new Set<string>([
    ...(barcodeCol ? [barcodeCol] : []),
    ...(itemCol ? [itemCol] : []),
    ...(!barcodeCol && !itemCol ? [keys[0]] : []),
  ]);

  rows.forEach(row => {
    let sohNum: number;
    if (sohCol) {
      sohNum = parseFloat(String(row[sohCol] ?? '').trim());
    } else {
      const numeric = Object.entries(row)
        .filter(([k]) => !identifierCols.has(k))
        .map(([, v]) => parseFloat(String(v ?? '').trim()))
        .find(n => !isNaN(n) && isFinite(n) && n < 1_000_000);
      sohNum = numeric ?? NaN;
    }
    if (isNaN(sohNum)) return;

    const rawBarcode = barcodeCol ? row[barcodeCol] : undefined;
    if (rawBarcode != null && rawBarcode !== '') {
      let barcodeStr = String(rawBarcode).trim();
      if (barcodeStr.endsWith('.0')) barcodeStr = barcodeStr.slice(0, -2);
      if (barcodeStr) mapByBarcode[barcodeStr] = (mapByBarcode[barcodeStr] ?? 0) + sohNum;
    }

    const rawItemNo = itemCol ? row[itemCol] : Object.values(row)[0];
    if (rawItemNo != null && rawItemNo !== '') {
      let itemStr = String(rawItemNo).trim();
      if (itemStr.endsWith('.0')) itemStr = itemStr.slice(0, -2);
      if (itemStr) mapByItem[itemStr] = (mapByItem[itemStr] ?? 0) + sohNum;
    }
  });

  return {
    byBarcode: mapByBarcode,
    byItem: mapByItem,
    count: Math.max(Object.keys(mapByBarcode).length, Object.keys(mapByItem).length),
  };
}

export function useSohData() {
  const [sohData, setSohData] = useState<Map<string, number>>(new Map());
  const [sohByItem, setSohByItem] = useState<Map<string, number>>(new Map());
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    async function init() {
      try {
        const stored = localStorage.getItem(SOH_STORAGE_KEY);
        if (stored) {
          setSohData(new Map<string, number>(
            Object.entries(JSON.parse(stored)).map(([k, v]) => [k, Number(v)])
          ));
        }
        const storedByItem = localStorage.getItem(SOH_ITEM_STORAGE_KEY);
        if (storedByItem) {
          setSohByItem(new Map<string, number>(
            Object.entries(JSON.parse(storedByItem)).map(([k, v]) => [k, Number(v)])
          ));
        }
      } catch (e) {
        console.error('Failed to load SOH data from local storage', e);
      }

      try {
        const metaRes = await fetch(`${getApiBase()}/api/soh-data/meta`);
        if (metaRes.ok) {
          const meta: { uploadedAt: string | null; count: number } = await metaRes.json();
          const cachedTs = localStorage.getItem(SOH_API_TS_KEY);
          if (meta.uploadedAt && meta.uploadedAt !== cachedTs && meta.count > 0) {
            const dataRes = await fetch(`${getApiBase()}/api/soh-data`);
            if (dataRes.ok) {
              const data: { byBarcode: Record<string, number>; byItem: Record<string, number> } = await dataRes.json();
              setSohData(new Map(Object.entries(data.byBarcode).map(([k, v]) => [k, Number(v)])));
              setSohByItem(new Map(Object.entries(data.byItem).map(([k, v]) => [k, Number(v)])));
              try { localStorage.setItem(SOH_STORAGE_KEY, JSON.stringify(data.byBarcode)); } catch {}
              try { localStorage.setItem(SOH_ITEM_STORAGE_KEY, JSON.stringify(data.byItem)); } catch {}
              localStorage.setItem(SOH_API_TS_KEY, meta.uploadedAt);
            }
          }
        }
      } catch {
        // API unavailable — use cached localStorage data
      }

      setIsLoaded(true);
    }
    init();
  }, []);

  const saveSohData = useCallback((rows: any[]) => {
    const { byBarcode, byItem } = buildSohMaps(rows);
    setSohData(new Map(Object.entries(byBarcode).map(([k, v]) => [k, Number(v)])));
    setSohByItem(new Map(Object.entries(byItem).map(([k, v]) => [k, Number(v)])));
    try { localStorage.setItem(SOH_STORAGE_KEY, JSON.stringify(byBarcode)); } catch (e) { console.error(e); }
    try { localStorage.setItem(SOH_ITEM_STORAGE_KEY, JSON.stringify(byItem)); } catch (e) { console.error(e); }
  }, []);

  const clearSohData = useCallback(() => {
    setSohData(new Map());
    setSohByItem(new Map());
    localStorage.removeItem(SOH_STORAGE_KEY);
    localStorage.removeItem(SOH_ITEM_STORAGE_KEY);
    localStorage.removeItem(SOH_API_TS_KEY);
  }, []);

  const lookupSoh = useCallback((barcode: string, itemNumber?: string): number | undefined => {
    let nb = String(barcode).trim();
    if (nb.endsWith('.0')) nb = nb.slice(0, -2);
    const byBarcode = sohData.get(nb);
    if (byBarcode != null) return byBarcode;

    if (itemNumber) {
      let ni = String(itemNumber).trim();
      if (ni.endsWith('.0')) ni = ni.slice(0, -2);
      const byItem = sohByItem.get(ni);
      if (byItem != null) return byItem;
    }
    return undefined;
  }, [sohData, sohByItem]);

  return { sohData, sohByItem, isLoaded, saveSohData, clearSohData, lookupSoh };
}
