import { useState, useEffect } from 'react';

export type BarcodeMasterRow = {
  barcode: string;
  itemNumber: string;
  description: string;
  rrp?: string;
  special?: string;
  soh?: string;
};

const STORAGE_KEY = 'expiry-scan-barcode-master';

export function useBarcodeMaster() {
  const [masterData, setMasterData] = useState<Map<string, BarcodeMasterRow>>(new Map());
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        const map = new Map<string, BarcodeMasterRow>(Object.entries(parsed));
        setMasterData(map);
      }
    } catch (e) {
      console.error('Failed to load barcode master from local storage', e);
    } finally {
      setIsLoaded(true);
    }
  }, []);

  const saveMasterData = (rows: any[]) => {
    const map = new Map<string, BarcodeMasterRow>();
    rows.forEach(row => {
      const keys = Object.keys(row);
      const getVal = (possibleNames: string[]) => {
        const key = keys.find(k => possibleNames.some(pn => k.toLowerCase().replace(/[\s_]/g, '').includes(pn.toLowerCase().replace(/[\s_]/g, ''))));
        return key ? String(row[key] ?? '').trim() : '';
      };

      let rawBarcode = getVal(['barcode', 'upc', 'ean', 'gtin']) || row['Barcode'] || row['barcode'];
      let itemNumber = getVal(['itemno', 'item', 'sku', 'article']) || row['ItemNumber'] || row['itemNumber'];
      let description = getVal(['desc', 'name', 'product']) || row['Description'] || row['description'];
      let rrp = getVal(['rrp', 'retailprice', 'retail']);
      let special = getVal(['special', 'specialprice', 'promo', 'sale']);
      let soh = getVal(['soh', 'stockonhand', 'stock', 'onhand', 'qty', 'quantity']);

      if (!rawBarcode && Object.values(row).length > 0) {
        const vals = Object.values(row);
        rawBarcode = vals[0];
        itemNumber = String(vals[1] || '');
        description = String(vals[2] || '');
      }

      if (rawBarcode) {
        let barcodeStr = String(rawBarcode).trim();
        if (barcodeStr.endsWith('.0')) {
          barcodeStr = barcodeStr.slice(0, -2);
        }
        map.set(barcodeStr, {
          barcode: barcodeStr,
          itemNumber: String(itemNumber || '').trim(),
          description: String(description || '').trim(),
          rrp: rrp || undefined,
          special: special || undefined,
          soh: soh || undefined,
        });
      }
    });
    
    setMasterData(map);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(map)));
    } catch (e) {
      console.error('Failed to save barcode master to local storage', e);
    }
  };

  const clearMasterData = () => {
    setMasterData(new Map());
    localStorage.removeItem(STORAGE_KEY);
  };

  const lookupBarcode = (barcode: string) => {
    let normalized = String(barcode).trim();
    if (normalized.endsWith('.0')) {
      normalized = normalized.slice(0, -2);
    }
    return masterData.get(normalized);
  };

  return {
    masterData,
    isLoaded,
    saveMasterData,
    clearMasterData,
    lookupBarcode
  };
}
