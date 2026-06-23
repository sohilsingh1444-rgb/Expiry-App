import { useState, useEffect, useCallback } from 'react';
import { getApiBase } from '@/lib/api-base';

export type BarcodeMasterRow = {
  barcode: string;
  itemNumber: string;
  description: string;
  rrp?: string;
  rrp_6?: string;
  rrp_12?: string;
  special?: string;
  special_start?: string;
  special_end?: string;
  rrp_CRWR?: string;
  rrp_CRWR_6?: string;
  rrp_CRWR_12?: string;
  special_CRWR?: string;
  special_CRWR_start?: string;
  special_CRWR_end?: string;
  rrp_NR?: string;
  rrp_NR_6?: string;
  rrp_NR_12?: string;
  special_NR?: string;
  special_NR_start?: string;
  special_NR_end?: string;
  rrp_WR?: string;
  rrp_WR_6?: string;
  rrp_WR_12?: string;
  special_WR?: string;
  special_WR_start?: string;
  special_WR_end?: string;
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

    const rawBarcode = getVal('barcode', 'upc', 'ean', 'gtin', 'plu', 'scancode', 'scan');
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
      findRegionCol('crwr', 'special', 'promo') ||
      getVal('special', 'specialprice', 'promo');
    const rrp_NR =
      findRegionCol('nr', 'rrp', 'retail', 'price');
    const special_NR =
      findRegionCol('nr', 'special', 'promo');

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
  rrpByItem: Record<string, Record<string, string>>
) {
  for (const row of map.values()) {
    const pricing = rrpByItem[row.itemNumber];
    if (!pricing) continue;
    if (pricing.rrp_CR) { row.rrp_CRWR = pricing.rrp_CR; if (!row.rrp) row.rrp = pricing.rrp_CR; }
    if (pricing.rrp_NR) row.rrp_NR = pricing.rrp_NR;
    if (pricing.rrp_WR) row.rrp_WR = pricing.rrp_WR;
    if (pricing.rrp_CR_6)  { row.rrp_CRWR_6 = pricing.rrp_CR_6; if (!row.rrp_6) row.rrp_6 = pricing.rrp_CR_6; }
    if (pricing.rrp_NR_6)  row.rrp_NR_6  = pricing.rrp_NR_6;
    if (pricing.rrp_WR_6)  row.rrp_WR_6  = pricing.rrp_WR_6;
    if (pricing.rrp_CR_12) { row.rrp_CRWR_12 = pricing.rrp_CR_12; if (!row.rrp_12) row.rrp_12 = pricing.rrp_CR_12; }
    if (pricing.rrp_NR_12) row.rrp_NR_12 = pricing.rrp_NR_12;
    if (pricing.rrp_WR_12) row.rrp_WR_12 = pricing.rrp_WR_12;
  }
}

export type SpecialsPricing = {
  special_CR?: string; special_CR_start?: string; special_CR_end?: string;
  special_NR?: string; special_NR_start?: string; special_NR_end?: string;
  special_WR?: string; special_WR_start?: string; special_WR_end?: string;
};

// Merge Specials pricing (from dedicated Specials file) into the barcode map in-place
export function mergeSpecialsIntoMap(
  map: Map<string, BarcodeMasterRow>,
  specialsByItem: Record<string, SpecialsPricing>
) {
  for (const row of map.values()) {
    const pricing = specialsByItem[row.itemNumber];
    if (!pricing) continue;
    if (pricing.special_CR) {
      row.special_CRWR = pricing.special_CR;
      row.special_CRWR_start = pricing.special_CR_start;
      row.special_CRWR_end = pricing.special_CR_end;
      if (!row.special) row.special = pricing.special_CR;
    }
    if (pricing.special_NR) {
      row.special_NR = pricing.special_NR;
      row.special_NR_start = pricing.special_NR_start;
      row.special_NR_end = pricing.special_NR_end;
    }
    if (pricing.special_WR) {
      row.special_WR = pricing.special_WR;
      row.special_WR_start = pricing.special_WR_start;
      row.special_WR_end = pricing.special_WR_end;
    }
  }
}

export function useBarcodeMaster() {
  const [masterData, setMasterData] = useState<Map<string, BarcodeMasterRow>>(new Map());
  const [masterByItem, setMasterByItem] = useState<Map<string, BarcodeMasterRow>>(new Map());
  const [isLoaded, setIsLoaded] = useState(false);
  const [rrpCount, setRrpCount] = useState(0);
  const [specialsCount, setSpecialsCount] = useState(0);

  useEffect(() => {
    async function init() {
      try {
        const [metaRes, rrpMetaRes, specialsMetaRes] = await Promise.all([
          fetch(`${getApiBase()}/api/barcode-master/meta`),
          fetch(`${getApiBase()}/api/rrp-data/meta`),
          fetch(`${getApiBase()}/api/specials-data/meta`),
        ]);

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
              setRrpCount(Object.keys(rrpData.byItem).length);
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
              setSpecialsCount(Object.keys(specData.byItem).length);
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

  const saveRrpData = useCallback((rrpByItem: Record<string, Record<string, string>>) => {
    setMasterData(prev => {
      const next = new Map(prev);
      mergeRrpIntoMap(next, rrpByItem);
      return next;
    });
    setMasterByItem(prev => {
      const next = new Map(prev);
      mergeRrpIntoMap(next, rrpByItem);
      return next;
    });
    setRrpCount(Object.keys(rrpByItem).length);
  }, []);

  const saveSpecialsData = useCallback((specialsByItem: Record<string, SpecialsPricing>) => {
    setMasterData(prev => {
      const next = new Map(prev);
      mergeSpecialsIntoMap(next, specialsByItem);
      return next;
    });
    setMasterByItem(prev => {
      const next = new Map(prev);
      mergeSpecialsIntoMap(next, specialsByItem);
      return next;
    });
    setSpecialsCount(Object.keys(specialsByItem).length);
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
        rrp_6: isNR ? (row.rrp_NR_6 || row.rrp_CRWR_6 || row.rrp_6) : isWR ? (row.rrp_WR_6 || row.rrp_CRWR_6 || row.rrp_6) : (row.rrp_CRWR_6 || row.rrp_6),
        rrp_12: isNR ? (row.rrp_NR_12 || row.rrp_CRWR_12 || row.rrp_12) : isWR ? (row.rrp_WR_12 || row.rrp_CRWR_12 || row.rrp_12) : (row.rrp_CRWR_12 || row.rrp_12),
        special: isNR ? (row.special_NR || row.special) : isWR ? (row.special_WR || row.special) : (row.special_CRWR || row.special),
        special_start: isNR ? (row.special_NR_start || row.special_CRWR_start) : isWR ? (row.special_WR_start || row.special_CRWR_start) : row.special_CRWR_start,
        special_end: isNR ? (row.special_NR_end || row.special_CRWR_end) : isWR ? (row.special_WR_end || row.special_CRWR_end) : row.special_CRWR_end,
      };
    }
    return row;
  }, [masterData, masterByItem]);

  return {
    masterData,
    isLoaded,
    rrpCount,
    specialsCount,
    saveMasterData,
    clearMasterData,
    saveRrpData,
    saveSpecialsData,
    lookupBarcode,
  };
}
