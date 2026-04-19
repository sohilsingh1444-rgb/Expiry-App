import { useState, useEffect } from 'react';

export type BarcodeMasterRow = {
  barcode: string;
  itemNumber: string;
  description: string;
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
      // Find keys that might match barcode, item number, description (case insensitive)
      const keys = Object.keys(row);
      const getVal = (possibleNames: string[]) => {
        const key = keys.find(k => possibleNames.some(pn => k.toLowerCase().includes(pn)));
        return key ? row[key] : '';
      };

      let rawBarcode = getVal(['barcode', 'upc', 'ean', 'gtin']) || row['Barcode'] || row['barcode'];
      let itemNumber = getVal(['item', 'sku', 'article']) || row['ItemNumber'] || row['itemNumber'];
      let description = getVal(['desc', 'name', 'product']) || row['Description'] || row['description'];

      if (!rawBarcode && Object.values(row).length > 0) {
         // fallback: first column is barcode, second is item, third is desc
         const vals = Object.values(row);
         rawBarcode = vals[0];
         itemNumber = vals[1] || '';
         description = vals[2] || '';
      }

      if (rawBarcode) {
        let barcodeStr = String(rawBarcode).trim();
        if (barcodeStr.endsWith('.0')) {
          barcodeStr = barcodeStr.slice(0, -2);
        }
        map.set(barcodeStr, {
          barcode: barcodeStr,
          itemNumber: String(itemNumber || '').trim(),
          description: String(description || '').trim()
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
