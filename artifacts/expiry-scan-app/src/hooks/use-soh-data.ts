import { useState, useEffect, useCallback } from 'react';

const SOH_STORAGE_KEY = 'expiry-scan-soh-data';
const SOH_ITEM_STORAGE_KEY = 'expiry-scan-soh-data-by-item';

export function useSohData() {
  const [sohData, setSohData] = useState<Map<string, number>>(new Map());
  const [sohByItem, setSohByItem] = useState<Map<string, number>>(new Map());
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
      const storedByItem = localStorage.getItem(SOH_ITEM_STORAGE_KEY);
      if (storedByItem) {
        const parsed = JSON.parse(storedByItem);
        const map = new Map<string, number>(
          Object.entries(parsed).map(([k, v]) => [k, Number(v)])
        );
        setSohByItem(map);
      }
    } catch (e) {
      console.error('Failed to load SOH data from local storage', e);
    } finally {
      setIsLoaded(true);
    }
  }, []);

  const saveSohData = useCallback((rows: any[]) => {
    const mapByBarcode = new Map<string, number>();
    const mapByItem = new Map<string, number>();

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
        getVal(['barcode', 'upc', 'ean', 'gtin']) ??
        Object.values(row)[0];
      const rawItemNo =
        getVal(['itemno', 'itemnum', 'itemnumber', 'itemcode', 'article', 'sku', 'item']) ??
        Object.values(row)[1];
      const sohVal =
        getVal(['soh', 'stockonhand', 'stock', 'onhand', 'available', 'qty', 'quantity']) ??
        Object.values(row)[2];

      const sohNum = parseFloat(String(sohVal ?? '0').trim());
      if (isNaN(sohNum)) return;

      if (rawBarcode != null) {
        let barcodeStr = String(rawBarcode).trim();
        if (barcodeStr.endsWith('.0')) barcodeStr = barcodeStr.slice(0, -2);
        if (barcodeStr) {
          mapByBarcode.set(barcodeStr, (mapByBarcode.get(barcodeStr) ?? 0) + sohNum);
        }
      }

      if (rawItemNo != null) {
        let itemStr = String(rawItemNo).trim();
        if (itemStr.endsWith('.0')) itemStr = itemStr.slice(0, -2);
        if (itemStr) {
          mapByItem.set(itemStr, (mapByItem.get(itemStr) ?? 0) + sohNum);
        }
      }
    });

    setSohData(mapByBarcode);
    setSohByItem(mapByItem);

    try {
      localStorage.setItem(SOH_STORAGE_KEY, JSON.stringify(Object.fromEntries(mapByBarcode)));
    } catch (e) {
      console.error('Failed to save SOH barcode data to local storage', e);
    }
    try {
      localStorage.setItem(SOH_ITEM_STORAGE_KEY, JSON.stringify(Object.fromEntries(mapByItem)));
    } catch (e) {
      console.error('Failed to save SOH item data to local storage', e);
    }
  }, []);

  const clearSohData = useCallback(() => {
    setSohData(new Map());
    setSohByItem(new Map());
    localStorage.removeItem(SOH_STORAGE_KEY);
    localStorage.removeItem(SOH_ITEM_STORAGE_KEY);
  }, []);

  const lookupSoh = useCallback((barcode: string, itemNumber?: string): number | undefined => {
    let normalizedBarcode = String(barcode).trim();
    if (normalizedBarcode.endsWith('.0')) normalizedBarcode = normalizedBarcode.slice(0, -2);

    const byBarcode = sohData.get(normalizedBarcode);
    if (byBarcode != null) return byBarcode;

    if (itemNumber) {
      let normalizedItem = String(itemNumber).trim();
      if (normalizedItem.endsWith('.0')) normalizedItem = normalizedItem.slice(0, -2);
      const byItem = sohByItem.get(normalizedItem);
      if (byItem != null) return byItem;
    }

    return undefined;
  }, [sohData, sohByItem]);

  return { sohData, isLoaded, saveSohData, clearSohData, lookupSoh };
}
