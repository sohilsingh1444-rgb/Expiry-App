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
  rrp_WR?: string;
  special_WR?: string;
  soh?: string;
};

// Barcode master is too large (~16 MB) for localStorage — always fetched from server

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

    // Match any column whose stripped name both contains a region suffix AND a field keyword.
    const findRegionCol = (region: string, ...fieldParts: string[]): string => {
      const r = region.replace(/[\s_\-]/g, '').toLowerCase();
      const key = keys.find(k => {
        const kl = k.toLowerCase().replace(/[\s_\-]/g, '');
        return (kl.endsWith(r) || kl.startsWith(r)) &&
          fieldParts.some(p => kl.includes(p.toLowerCase().replace(/[\s_\-]/g, '')));
      });
      return key ? String(row[key] ?? '').trim() : '';
    };

    const rrp_CRWR =
      findRegionCol('crwr', 'rrp', 'retail', 'price') ||
      getVal('rrp', 'retailprice', 'retail');
    const special_CRWR =
      findRegionCol('crwr', 'special', 'offer', 'promo', 'sale') ||
      getVal('special', 'specialprice', 'promo', 'sale', 'offerprice', 'offer', 'saleprice');
    const rrp_NR =
      findRegionCol('nr', 'rrp', 'retail', 'price');
    const special_NR =
      findRegionCol('nr', 'special', 'offer', 'promo', 'sale');

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

// Merge RRP pricing (from dedicated RRP file) into the barcode map in-place
export function mergeRrpIntoMap(
  map: Map<string, BarcodeMasterRow>,
  rrpByItem: Record<string, { rrp_CR?: string; rrp_NR?: string; rrp_WR?: string }>
) {
  for (const row of map.values()) {
    const pricing = rrpByItem[row.itemNumber];
    if (!pricing) continue;
    if (pricing.rrp_CR) { row.rrp_CRWR = pricing.rrp_CR; if (!row.rrp) row.rrp = pricing.rrp_CR; }
    if (pricing.rrp_NR) row.rrp_NR = pricing.rrp_NR;
    if (pricing.rrp_WR) row.rrp_WR = pricing.rrp_WR;
  }
}

// Merge Specials pricing (from dedicated Specials file) into the barcode map in-place
export function mergeSpecialsIntoMap(
  map: Map<string, BarcodeMasterRow>,
  specialsByItem: Record<string, { special_CR?: string; special_NR?: string; special_WR?: string }>
) {
  for (const row of map.values()) {
    const pricing = specialsByItem[row.itemNumber];
    if (!pricing) continue;
    if (pricing.special_CR) { row.special_CRWR = pricing.special_CR; if (!row.special) row.special = pricing.special_CR; }
    if (pricing.special_NR) row.special_NR = pricing.special_NR;
    if (pricing.special_WR) row.special_WR = pricing.special_WR;
  }
}

export function useBarcodeMaster() {
  const [masterData, setMasterData] = useState<Map<string, BarcodeMasterRow>>(new Map());
  const [masterByItem, setMasterByItem] = useState<Map<string, BarcodeMasterRow>>(new Map());
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    async function init() {
      try {
        const [metaRes, rrpMetaRes, specialsMetaRes] = await Promise.all([
          fetch(`${getApiBase()}/api/barcode-master/meta`),
          fetch(`${getApiBase()}/api/rrp-data/meta`),
          fetch(`${getApiBase()}/api/specials-data/meta`),
        ]);

        const hasBm = metaRes.ok && (() => {
          const m = metaRes.json(); return m;
        });

        // Fetch barcode master if available
        let map = new Map<string, BarcodeMasterRow>();
        if (metaRes.ok) {
          const meta: { uploadedAt: string | null; count: number } = await metaRes.json();
          if (meta.uploadedAt && meta.count > 0) {
            const dataRes = await fetch(`${getApiBase()}/api/barcode-master`);
            if (dataRes.ok) {
              const data: { map: Record<string, BarcodeMasterRow> } = await dataRes.json();
              map = new Map(Object.entries(data.map));
            }
          }
        }

        // Fetch and merge RRP data if available
        if (rrpMetaRes.ok) {
          const rrpMeta: { uploadedAt: string | null; count: number } = await rrpMetaRes.json();
          if (rrpMeta.uploadedAt && rrpMeta.count > 0) {
            const rrpRes = await fetch(`${getApiBase()}/api/rrp-data`);
            if (rrpRes.ok) {
              const rrpData: { byItem: Record<string, { rrp_CR?: string; rrp_NR?: string; rrp_WR?: string }> } = await rrpRes.json();
              mergeRrpIntoMap(map, rrpData.byItem);
            }
          }
        }

        // Fetch and merge Specials data if available
        if (specialsMetaRes.ok) {
          const specMeta: { uploadedAt: string | null; count: number } = await specialsMetaRes.json();
          if (specMeta.uploadedAt && specMeta.count > 0) {
            const specRes = await fetch(`${getApiBase()}/api/specials-data`);
            if (specRes.ok) {
              const specData: { byItem: Record<string, { special_CR?: string; special_NR?: string; special_WR?: string }> } = await specRes.json();
              mergeSpecialsIntoMap(map, specData.byItem);
            }
          }
        }

        // Build byItem index
        const byItem = new Map<string, BarcodeMasterRow>();
        for (const row of map.values()) {
          if (row.itemNumber && (!byItem.has(row.itemNumber) || (row.rrp && !byItem.get(row.itemNumber)!.rrp))) {
            byItem.set(row.itemNumber, row);
          }
        }

        setMasterData(map);
        setMasterByItem(byItem);
      } catch {
        // API unavailable
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
  }, []);

  const clearMasterData = useCallback(() => {
    setMasterData(new Map());
    setMasterByItem(new Map());
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
      const r = region.toUpperCase();
      const isNR = r === 'NR';
      const isWR = r === 'WR';
      return {
        ...row,
        rrp: isNR ? (row.rrp_NR || row.rrp) : isWR ? (row.rrp_WR || row.rrp) : (row.rrp_CRWR || row.rrp),
        special: isNR ? (row.special_NR || row.special) : isWR ? (row.special_WR || row.special) : (row.special_CRWR || row.special),
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
