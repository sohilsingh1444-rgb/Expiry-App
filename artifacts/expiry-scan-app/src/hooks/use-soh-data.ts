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
    } finally {
      setIsLoaded(true);
    }
  }, []);

  const saveSohData = useCallback((rows: any[]) => {
    if (!rows.length) return;

    const mapByBarcode = new Map<string, number>();
    const mapByItem = new Map<string, number>();

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
                                'totalstock', 'balanceqty', 'qtyonhand', 'availqty', 'quantity', 'qty']);

    // Determine which column index is the identifier so we can skip it in numeric fallback
    const identifierKey = barcodeCol ?? itemCol ?? keys[0];
    const identifierIdx = keys.indexOf(identifierKey);

    rows.forEach(row => {
      // SOH value: named column first, then first numeric value that isn't the identifier column
      let sohNum: number;
      if (sohCol) {
        sohNum = parseFloat(String(row[sohCol] ?? '').trim());
      } else {
        const numeric = Object.entries(row)
          .filter(([k]) => k !== identifierKey)
          .map(([, v]) => parseFloat(String(v ?? '').trim()))
          .find(n => !isNaN(n) && isFinite(n));
        sohNum = numeric ?? NaN;
      }
      if (isNaN(sohNum)) return;

      const rawBarcode = barcodeCol ? row[barcodeCol] : (identifierIdx === 0 ? undefined : Object.values(row)[0]);
      if (rawBarcode != null && rawBarcode !== '') {
        let barcodeStr = String(rawBarcode).trim();
        if (barcodeStr.endsWith('.0')) barcodeStr = barcodeStr.slice(0, -2);
        if (barcodeStr) mapByBarcode.set(barcodeStr, (mapByBarcode.get(barcodeStr) ?? 0) + sohNum);
      }

      const rawItemNo = itemCol ? row[itemCol] : Object.values(row)[identifierIdx >= 0 ? identifierIdx : 0];
      if (rawItemNo != null && rawItemNo !== '') {
        let itemStr = String(rawItemNo).trim();
        if (itemStr.endsWith('.0')) itemStr = itemStr.slice(0, -2);
        if (itemStr) mapByItem.set(itemStr, (mapByItem.get(itemStr) ?? 0) + sohNum);
      }
    });

    setSohData(mapByBarcode);
    setSohByItem(mapByItem);

    try { localStorage.setItem(SOH_STORAGE_KEY, JSON.stringify(Object.fromEntries(mapByBarcode))); }
    catch (e) { console.error('Failed to save SOH barcode data to local storage', e); }
    try { localStorage.setItem(SOH_ITEM_STORAGE_KEY, JSON.stringify(Object.fromEntries(mapByItem))); }
    catch (e) { console.error('Failed to save SOH item data to local storage', e); }
  }, []);

  const clearSohData = useCallback(() => {
    setSohData(new Map());
    setSohByItem(new Map());
    localStorage.removeItem(SOH_STORAGE_KEY);
    localStorage.removeItem(SOH_ITEM_STORAGE_KEY);
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
