import { useState, useEffect, useCallback } from 'react';

const SOH_STORAGE_KEY = 'expiry-scan-soh-data';

export function useSohData() {
  const [sohData, setSohData] = useState<Map<string, number>>(new Map());
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(SOH_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        const map = new Map<string, number>(
          Object.entries(parsed).map(([k, v]) => [k, Number(v)])
        );
        setSohData(map);
      }
    } catch (e) {
      console.error('Failed to load SOH data from local storage', e);
    } finally {
      setIsLoaded(true);
    }
  }, []);

  const saveSohData = useCallback((rows: any[]) => {
    const map = new Map<string, number>();
    rows.forEach(row => {
      const keys = Object.keys(row);
      const getVal = (possibleNames: string[]) => {
        const key = keys.find(k =>
          possibleNames.some(pn =>
            k.toLowerCase().replace(/[\s_]/g, '').includes(pn.toLowerCase().replace(/[\s_]/g, ''))
          )
        );
        return key ? row[key] : undefined;
      };

      const rawBarcode =
        getVal(['barcode', 'upc', 'ean', 'gtin', 'code', 'item']) ??
        Object.values(row)[0];
      const sohVal =
        getVal(['soh', 'stockonhand', 'stock', 'onhand', 'available', 'qty', 'quantity']) ??
        Object.values(row)[1];

      if (rawBarcode != null) {
        let barcodeStr = String(rawBarcode).trim();
        if (barcodeStr.endsWith('.0')) barcodeStr = barcodeStr.slice(0, -2);
        const sohNum = parseFloat(String(sohVal ?? '0').trim());
        if (!isNaN(sohNum)) {
          map.set(barcodeStr, sohNum);
        }
      }
    });

    setSohData(map);
    try {
      localStorage.setItem(SOH_STORAGE_KEY, JSON.stringify(Object.fromEntries(map)));
    } catch (e) {
      console.error('Failed to save SOH data to local storage', e);
    }
  }, []);

  const clearSohData = useCallback(() => {
    setSohData(new Map());
    localStorage.removeItem(SOH_STORAGE_KEY);
  }, []);

  const lookupSoh = useCallback((barcode: string): number | undefined => {
    let normalized = String(barcode).trim();
    if (normalized.endsWith('.0')) normalized = normalized.slice(0, -2);
    return sohData.get(normalized);
  }, [sohData]);

  return { sohData, isLoaded, saveSohData, clearSohData, lookupSoh };
}
