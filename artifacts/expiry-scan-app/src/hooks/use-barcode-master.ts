import { useState, useEffect, useCallback } from 'react';
import { getApiBase } from '@/lib/api-base';

export type BarcodeMasterRow = {
  barcode: string;
  itemNumber: string;
  description: string;
  rrp?: string;
  special?: string;
  rrp_CRWR?: string;
  special_CRWR?: string;
  rrp_NR?: string;
  special_NR?: string;
  soh?: string;
};

const STORAGE_KEY = 'expiry-scan-barcode-master';
const ITEM_INDEX_KEY = 'expiry-scan-barcode-master-by-item';
const API_TS_KEY = 'expiry-scan-barcode-master-api-ts';

export function buildBarcodeMaps(rows: any[]): {
  map: Record<string, BarcodeMasterRow>;
  byItem: Record<string, BarcodeMasterRow>;
  count: number;
} {
  const map: Record<string, BarcodeMasterRow> = {};
  const byItem: Record<string, BarcodeMasterRow> = {};

  rows.forEach(row => {
    const keys = Object.keys(row);

    const getVal = (...possibleNames: string[]) => {
      const key = keys.find(k =>
        possibleNames.some(pn =>
          k.toLowerCase().replace(/[\s_\-]/g, '').includes(pn.toLowerCase().replace(/[\s_\-]/g, ''))
        )
      );
      return key ? String(row[key] ?? '').trim() : '';
    };

    const rawBarcode = getVal('barcode', 'upc', 'ean', 'gtin');
    const itemNumber = getVal('itemno', 'item', 'sku', 'article', 'itemnum', 'itemnumber', 'itemcode');
    const description = getVal('desc', 'description', 'name', 'product');
    const soh = getVal('soh', 'stockonhand', 'stock', 'onhand');

    const rrp_CRWR =
      getVal('rrp_crwr', 'retailprice_crwr', 'price_crwr') ||
      getVal('rrp', 'retailprice', 'retail');
    const special_CRWR =
      getVal('offerprice_crwr', 'offer_crwr', 'special_crwr', 'promo_crwr', 'saleprice_crwr') ||
      getVal('special', 'specialprice', 'promo', 'sale', 'offerprice', 'offer', 'saleprice');
    const rrp_NR = getVal('rrp_nr', 'retailprice_nr', 'price_nr');
    const special_NR = getVal('offerprice_nr', 'offer_nr', 'special_nr', 'promo_nr', 'saleprice_nr');

    const entry: BarcodeMasterRow = {
      barcode: rawBarcode ? String(rawBarcode).trim().replace(/\.0$/, '') : '',
      itemNumber: String(itemNumber || '').trim().replace(/\.0$/, ''),
      description: String(description || '').trim(),
      rrp: rrp_CRWR || undefined,
      special: special_CRWR || undefined,
      rrp_CRWR: rrp_CRWR || undefined,
      special_CRWR: special_CRWR || undefined,
      rrp_NR: rrp_NR || undefined,
      special_NR: special_NR || undefined,
      soh: soh || undefined,
    };

    if (entry.barcode) map[entry.barcode] = entry;
    if (entry.itemNumber) {
      if (!byItem[entry.itemNumber] || (entry.rrp && !byItem[entry.itemNumber].rrp)) {
        byItem[entry.itemNumber] = entry;
      }
    }
  });

  return { map, byItem, count: Math.max(Object.keys(map).length, Object.keys(byItem).length) };
}

export function useBarcodeMaster() {
  const [masterData, setMasterData] = useState<Map<string, BarcodeMasterRow>>(new Map());
  const [masterByItem, setMasterByItem] = useState<Map<string, BarcodeMasterRow>>(new Map());
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    async function init() {
      try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) setMasterData(new Map<string, BarcodeMasterRow>(Object.entries(JSON.parse(stored))));
        const storedByItem = localStorage.getItem(ITEM_INDEX_KEY);
        if (storedByItem) setMasterByItem(new Map<string, BarcodeMasterRow>(Object.entries(JSON.parse(storedByItem))));
      } catch (e) {
        console.error('Failed to load barcode master from local storage', e);
      }

      try {
        const metaRes = await fetch(`${getApiBase()}/api/barcode-master/meta`);
        if (metaRes.ok) {
          const meta: { uploadedAt: string | null; count: number } = await metaRes.json();
          const cachedTs = localStorage.getItem(API_TS_KEY);
          if (meta.uploadedAt && meta.uploadedAt !== cachedTs && meta.count > 0) {
            const dataRes = await fetch(`${getApiBase()}/api/barcode-master`);
            if (dataRes.ok) {
              const data: { map: Record<string, BarcodeMasterRow>; byItem: Record<string, BarcodeMasterRow> } = await dataRes.json();
              setMasterData(new Map(Object.entries(data.map)));
              setMasterByItem(new Map(Object.entries(data.byItem)));
              try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data.map)); } catch {}
              try { localStorage.setItem(ITEM_INDEX_KEY, JSON.stringify(data.byItem)); } catch {}
              localStorage.setItem(API_TS_KEY, meta.uploadedAt);
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

  const saveMasterData = useCallback((rows: any[]) => {
    const { map, byItem } = buildBarcodeMaps(rows);
    const mapM = new Map(Object.entries(map));
    const byItemM = new Map(Object.entries(byItem));
    setMasterData(mapM);
    setMasterByItem(byItemM);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(map)); } catch (e) { console.error(e); }
    try { localStorage.setItem(ITEM_INDEX_KEY, JSON.stringify(byItem)); } catch (e) { console.error(e); }
  }, []);

  const clearMasterData = useCallback(() => {
    setMasterData(new Map());
    setMasterByItem(new Map());
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(ITEM_INDEX_KEY);
    localStorage.removeItem(API_TS_KEY);
  }, []);

  const lookupBarcode = useCallback((barcode: string, region?: string, itemNumber?: string): BarcodeMasterRow | undefined => {
    let normalized = String(barcode).trim();
    if (normalized.endsWith('.0')) normalized = normalized.slice(0, -2);

    let row = masterData.get(normalized);

    if (!row && itemNumber) {
      let ni = String(itemNumber).trim();
      if (ni.endsWith('.0')) ni = ni.slice(0, -2);
      row = masterByItem.get(ni);
    }

    if (!row) return undefined;

    if (region) {
      const isNR = region.toUpperCase() === 'NR';
      return {
        ...row,
        rrp: isNR ? (row.rrp_NR || row.rrp) : (row.rrp_CRWR || row.rrp),
        special: isNR ? (row.special_NR || row.special) : (row.special_CRWR || row.special),
      };
    }
    return row;
  }, [masterData, masterByItem]);

  return {
    masterData,
    isLoaded,
    saveMasterData,
    clearMasterData,
    lookupBarcode,
  };
}
