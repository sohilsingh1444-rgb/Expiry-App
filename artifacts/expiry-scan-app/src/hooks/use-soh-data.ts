import { useState, useEffect, useCallback } from 'react';
import { getApiBase } from '@/lib/api-base';

export type SohStoreMap = Record<string, { byBarcode: Record<string, number>; byItem: Record<string, number> }>;
export type SohRegionMap = Record<string, { byBarcode: Record<string, number>; byItem: Record<string, number> }>;

export function buildSohMaps(rows: any[]): {
  byBarcode: Record<string, number>;
  byItem: Record<string, number>;
  byStore: SohStoreMap;
  byRegion: SohRegionMap;
  count: number;
} {
  if (!rows.length) return { byBarcode: {}, byItem: {}, byStore: {}, byRegion: {}, count: 0 };

  const mapByBarcode: Record<string, number> = {};
  const mapByItem: Record<string, number> = {};
  const mapByStore: SohStoreMap = {};
  const mapByRegion: SohRegionMap = {};

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
  const regionCol  = findCol(['region', 'pricegroup', 'pricegrp', 'area', 'zone', 'salescod', 'salescode']);
  const sohCol     = findCol(['soh', 'stockonhand', 'stock', 'onhand', 'available', 'totalqty',
                              'totalstock', 'balanceqty', 'qtyonhand', 'availqty', 'quantity', 'qty',
                              'inventory', 'inv', 'inven', 'onhandqty', 'physicalinv']);

  const identifierCols = new Set<string>([
    ...(barcodeCol ? [barcodeCol] : []),
    ...(itemCol ? [itemCol] : []),
    ...(storeCol ? [storeCol] : []),
    ...(regionCol ? [regionCol] : []),
    ...(!barcodeCol && !itemCol ? [keys[0]] : []),
  ]);

  const VALID_REGIONS = new Set(['CR', 'NR', 'WR']);

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

    // Build byRegion — detect region from dedicated region column OR from storeCol value (CR/NR/WR)
    let regionKey = '';
    if (regionCol) {
      const rv = String(row[regionCol] ?? '').trim().toUpperCase();
      if (VALID_REGIONS.has(rv)) regionKey = rv;
    }
    if (!regionKey && storeCol) {
      // Many SOH files have "CR", "NR", or "WR" directly in the store/location column
      const sv = String(row[storeCol] ?? '').trim().toUpperCase();
      if (VALID_REGIONS.has(sv)) regionKey = sv;
    }
    if (regionKey) {
      if (!mapByRegion[regionKey]) mapByRegion[regionKey] = { byBarcode: {}, byItem: {} };
      if (barcodeStr) mapByRegion[regionKey].byBarcode[barcodeStr] = (mapByRegion[regionKey].byBarcode[barcodeStr] ?? 0) + sohNum;
      if (itemStr) mapByRegion[regionKey].byItem[itemStr] = (mapByRegion[regionKey].byItem[itemStr] ?? 0) + sohNum;
    }
  });

  return {
    byBarcode: mapByBarcode,
    byItem: mapByItem,
    byStore: mapByStore,
    byRegion: mapByRegion,
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
  const [sohByRegion, setSohByRegion] = useState<Map<string, { byBarcode: Record<string, number>; byItem: Record<string, number> }>>(new Map());
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
              const data: { byBarcode: Record<string, number>; byItem: Record<string, number>; byStore?: SohStoreMap; byRegion?: SohRegionMap } = await dataRes.json();
              setSohData(new Map(Object.entries(data.byBarcode).map(([k, v]) => [k, Number(v)])));
              setSohByItem(new Map(Object.entries(data.byItem).map(([k, v]) => [k, Number(v)])));
              if (data.byStore) setSohByStore(new Map(Object.entries(data.byStore)));
              if (data.byRegion) setSohByRegion(new Map(Object.entries(data.byRegion)));
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
    const { byBarcode, byItem, byStore, byRegion } = buildSohMaps(rows);
    setSohData(new Map(Object.entries(byBarcode).map(([k, v]) => [k, Number(v)])));
    setSohByItem(new Map(Object.entries(byItem).map(([k, v]) => [k, Number(v)])));
    setSohByStore(new Map(Object.entries(byStore)));
    setSohByRegion(new Map(Object.entries(byRegion)));
  }, []);

  const clearSohData = useCallback(() => {
    setSohData(new Map());
    setSohByItem(new Map());
    setSohByStore(new Map());
    setSohByRegion(new Map());
  }, []);

  const lookupSoh = useCallback((barcode: string, itemNumber?: string, storeIdentifiers?: string[], region?: string): number | undefined => {
    let nb = String(barcode).trim();
    if (nb.endsWith('.0')) nb = nb.slice(0, -2);
    let ni = '';
    if (itemNumber) {
      ni = String(itemNumber).trim();
      if (ni.endsWith('.0')) ni = ni.slice(0, -2);
    }

    // Tier 1: store-specific lookup
    if (storeIdentifiers && storeIdentifiers.length > 0) {
      const storeData = findStoreData(sohByStore, storeIdentifiers);
      if (storeData) {
        const bySb = storeData.byBarcode[nb];
        if (bySb != null) return bySb;
        if (ni) {
          const byIb = storeData.byItem[ni];
          if (byIb != null) return byIb;
        }
      }
    }

    // Tier 2: region-specific lookup (CR / NR / WR)
    if (region) {
      const regionData = sohByRegion.get(region.toUpperCase());
      if (regionData) {
        const byRb = regionData.byBarcode[nb];
        if (byRb != null) return byRb;
        if (ni) {
          const byRi = regionData.byItem[ni];
          if (byRi != null) return byRi;
        }
      }
    }

    // Tier 3: global fallback
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
