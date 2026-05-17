import { useState, useEffect, useCallback } from 'react';
import { getApiBase } from '@/lib/api-base';

export type SohStoreMap = Record<string, { byBarcode: Record<string, number>; byItem: Record<string, number> }>;

export function buildSohMaps(rows: any[]): {
  byBarcode: Record<string, number>;
  byItem: Record<string, number>;
  byStore: SohStoreMap;
  count: number;
} {
  if (!rows.length) return { byBarcode: {}, byItem: {}, byStore: {}, count: 0 };

  const mapByBarcode: Record<string, number> = {};
  const mapByItem: Record<string, number> = {};
  const mapByStore: SohStoreMap = {};

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
  const storeCol   = findCol(['storelocation', 'storename', 'store', 'location', 'branch', 'outlet', 'site']);
  const sohCol     = findCol(['soh', 'stockonhand', 'stock', 'onhand', 'available', 'totalqty',
                              'totalstock', 'balanceqty', 'qtyonhand', 'availqty', 'quantity', 'qty',
                              'inventory', 'inv', 'inven', 'onhandqty', 'physicalinv']);

  const identifierCols = new Set<string>([
    ...(barcodeCol ? [barcodeCol] : []),
    ...(itemCol ? [itemCol] : []),
    ...(storeCol ? [storeCol] : []),
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
    let barcodeStr = '';
    if (rawBarcode != null && rawBarcode !== '') {
      barcodeStr = String(rawBarcode).trim();
      if (barcodeStr.endsWith('.0')) barcodeStr = barcodeStr.slice(0, -2);
      if (barcodeStr) mapByBarcode[barcodeStr] = (mapByBarcode[barcodeStr] ?? 0) + sohNum;
    }

    const rawItemNo = itemCol ? row[itemCol] : Object.values(row)[0];
    let itemStr = '';
    if (rawItemNo != null && rawItemNo !== '') {
      itemStr = String(rawItemNo).trim();
      if (itemStr.endsWith('.0')) itemStr = itemStr.slice(0, -2);
      if (itemStr) mapByItem[itemStr] = (mapByItem[itemStr] ?? 0) + sohNum;
    }

    if (storeCol) {
      const storeRaw = String(row[storeCol] ?? '').trim();
      if (storeRaw) {
        const storeKey = storeRaw.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (storeKey) {
          if (!mapByStore[storeKey]) mapByStore[storeKey] = { byBarcode: {}, byItem: {} };
          if (barcodeStr) mapByStore[storeKey].byBarcode[barcodeStr] = (mapByStore[storeKey].byBarcode[barcodeStr] ?? 0) + sohNum;
          if (itemStr) mapByStore[storeKey].byItem[itemStr] = (mapByStore[storeKey].byItem[itemStr] ?? 0) + sohNum;
        }
      }
    }
  });

  return {
    byBarcode: mapByBarcode,
    byItem: mapByItem,
    byStore: mapByStore,
    count: Math.max(Object.keys(mapByBarcode).length, Object.keys(mapByItem).length),
  };
}

function findStoreData(
  byStore: Map<string, { byBarcode: Record<string, number>; byItem: Record<string, number> }>,
  storeIdentifiers: string[],
): { byBarcode: Record<string, number>; byItem: Record<string, number> } | undefined {
  if (!storeIdentifiers.length || byStore.size === 0) return undefined;
  for (const id of storeIdentifiers) {
    if (!id) continue;
    const needle = id.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!needle) continue;
    if (byStore.has(needle)) return byStore.get(needle);
    for (const [k, v] of byStore) {
      if (needle.includes(k) || k.includes(needle)) return v;
    }
  }
  return undefined;
}

export function useSohData() {
  const [sohData, setSohData] = useState<Map<string, number>>(new Map());
  const [sohByItem, setSohByItem] = useState<Map<string, number>>(new Map());
  const [sohByStore, setSohByStore] = useState<Map<string, { byBarcode: Record<string, number>; byItem: Record<string, number> }>>(new Map());
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    async function init() {
      try {
        const metaRes = await fetch(`${getApiBase()}/api/soh-data/meta`);
        if (metaRes.ok) {
          const meta: { uploadedAt: string | null; count: number } = await metaRes.json();
          if (meta.uploadedAt && meta.count > 0) {
            const dataRes = await fetch(`${getApiBase()}/api/soh-data`);
            if (dataRes.ok) {
              const data: { byBarcode: Record<string, number>; byItem: Record<string, number>; byStore?: SohStoreMap } = await dataRes.json();
              setSohData(new Map(Object.entries(data.byBarcode).map(([k, v]) => [k, Number(v)])));
              setSohByItem(new Map(Object.entries(data.byItem).map(([k, v]) => [k, Number(v)])));
              if (data.byStore) setSohByStore(new Map(Object.entries(data.byStore)));
            }
          }
        }
      } catch {
        // API unavailable
      }

      setIsLoaded(true);
    }
    init();
  }, []);

  const saveSohData = useCallback((rows: any[]) => {
    const { byBarcode, byItem, byStore } = buildSohMaps(rows);
    setSohData(new Map(Object.entries(byBarcode).map(([k, v]) => [k, Number(v)])));
    setSohByItem(new Map(Object.entries(byItem).map(([k, v]) => [k, Number(v)])));
    setSohByStore(new Map(Object.entries(byStore)));
  }, []);

  const clearSohData = useCallback(() => {
    setSohData(new Map());
    setSohByItem(new Map());
    setSohByStore(new Map());
  }, []);

  const lookupSoh = useCallback((barcode: string, itemNumber?: string, storeIdentifiers?: string[]): number | undefined => {
    let nb = String(barcode).trim();
    if (nb.endsWith('.0')) nb = nb.slice(0, -2);

    if (storeIdentifiers && storeIdentifiers.length > 0) {
      const storeData = findStoreData(sohByStore, storeIdentifiers);
      if (storeData) {
        const bySb = storeData.byBarcode[nb];
        if (bySb != null) return bySb;
        if (itemNumber) {
          let ni = String(itemNumber).trim();
          if (ni.endsWith('.0')) ni = ni.slice(0, -2);
          const byIb = storeData.byItem[ni];
          if (byIb != null) return byIb;
        }
      }
    }

    const byBarcode = sohData.get(nb);
    if (byBarcode != null) return byBarcode;

    if (itemNumber) {
      let ni = String(itemNumber).trim();
      if (ni.endsWith('.0')) ni = ni.slice(0, -2);
      const byItem = sohByItem.get(ni);
      if (byItem != null) return byItem;
    }
    return undefined;
  }, [sohData, sohByItem, sohByStore]);

  return { sohData, sohByItem, sohByStore, isLoaded, saveSohData, clearSohData, lookupSoh };
}
