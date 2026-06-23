function extractCellValue(v: unknown): any {
  if (v == null) return '';
  if (typeof v !== 'object') return v;
  if (v instanceof Date) return v;
  const obj = v as Record<string, any>;
  if (Array.isArray(obj.richText)) {
    return obj.richText.map((rt: any) => String(rt.text ?? '')).join('');
  }
  if ('result' in obj) return obj.result ?? '';
  if ('error' in obj) return '';
  return String(v);
}

function parseCsvText(text: string): any[][] {
  // Normalise line endings
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const aoa: any[][] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const row: any[] = [];
    let inQuote = false;
    let cell = '';
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuote && line[i + 1] === '"') { cell += '"'; i++; }
        else { inQuote = !inQuote; }
      } else if (ch === ',' && !inQuote) {
        row.push(cell); cell = '';
      } else {
        cell += ch;
      }
    }
    row.push(cell);
    aoa.push(row);
  }
  return aoa;
}

async function readWorksheetAsAoa(file: File): Promise<any[][]> {
  const isCsv = file.name.toLowerCase().endsWith('.csv') || file.type === 'text/csv';
  if (isCsv) {
    const text = await file.text();
    return parseCsvText(text);
  }

  try {
    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await file.arrayBuffer());
    const sheet = workbook.worksheets[0];
    if (!sheet) return [];

    const aoa: any[][] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const vals = row.values as any[];
      const rowArr: any[] = vals.slice(1).map(extractCellValue);
      aoa.push(rowArr);
    });
    return aoa;
  } catch {
    // Last-resort: try treating it as CSV text
    const text = await file.text();
    return parseCsvText(text);
  }
}

export async function parseBarcodeMaster(file: File): Promise<any[]> {
  let aoa: any[][];
  try { aoa = await readWorksheetAsAoa(file); } catch { return []; }
  if (!Array.isArray(aoa) || aoa.length < 2 || !Array.isArray(aoa[0])) return [];

  const REGION_CODES = new Set(['CR|WR', 'CR', 'NR', 'WR', 'CRWR']);
  let regionRowIdx = -1;
  for (let i = 0; i < Math.min(aoa.length, 10); i++) {
    const rowUpper = aoa[i].map((c: any) => String(c ?? '').trim().toUpperCase());
    const nonEmpty = rowUpper.filter(c => c !== '');
    // A genuine region-separator row has ≥2 region codes and every non-empty cell is a region code.
    if (nonEmpty.length >= 2 && nonEmpty.every(c => REGION_CODES.has(c))) {
      regionRowIdx = i;
      break;
    }
  }

  if (regionRowIdx === -1) {
    const headers = aoa[0].map((c: any) => String(c ?? ''));
    const result: any[] = [];
    for (let r = 1; r < aoa.length; r++) {
      const row = aoa[r];
      if (!row || row.every((c: any) => c === '' || c == null)) continue;
      const obj: any = {};
      headers.forEach((h, c) => { if (h) obj[h] = row[c] ?? ''; });
      result.push(obj);
    }
    return result;
  }

  const headerRowIdx = regionRowIdx + 1;
  const regionRow: string[] = aoa[regionRowIdx].map((c: any) => String(c ?? '').trim().toUpperCase());
  const headerRow: string[] = aoa[headerRowIdx]?.map((c: any) => String(c ?? '').trim().toLowerCase().replace(/\s+/g, '')) ?? [];

  const colRegions: string[] = [];
  let currentRegion = '';
  for (let c = 0; c < Math.max(regionRow.length, headerRow.length); c++) {
    const cell = regionRow[c] ?? '';
    if (cell === 'NR') currentRegion = 'NR';
    else if (cell.includes('CR') || cell.includes('WR')) currentRegion = 'CRWR';
    colRegions[c] = currentRegion;
  }

  const colNames: string[] = headerRow.map((h, c) => {
    if (!h) return `__col${c}`;
    return colRegions[c] ? `${h}_${colRegions[c].toLowerCase()}` : h;
  });

  const result: any[] = [];
  for (let r = headerRowIdx + 1; r < aoa.length; r++) {
    const row = aoa[r];
    if (!row || row.every((c: any) => c === '' || c == null)) continue;
    const obj: any = {};
    colNames.forEach((name, c) => {
      if (!name.startsWith('__col')) obj[name] = row[c] ?? '';
    });
    result.push(obj);
  }
  return result;
}

// ── RRP file parser ────────────────────────────────────────────────────────
// Expected columns: Sales Type, Sales Code (region: CR/NR/WR), Item No.,
// Item Description, Unit of Measure Code, Unit Price Including VAT,
// Starting Date, Ending Date
export async function parseRrpFile(file: File): Promise<any[]> {
  let aoa: any[][];
  try { aoa = await readWorksheetAsAoa(file); } catch { return []; }
  if (!Array.isArray(aoa) || aoa.length < 2 || !Array.isArray(aoa[0])) return [];
  const headers = aoa[0].map((c: any) => String(c ?? '').trim());
  const result: any[] = [];
  for (let r = 1; r < aoa.length; r++) {
    const row = aoa[r];
    if (!row || row.every((c: any) => c === '' || c == null)) continue;
    const obj: any = {};
    headers.forEach((h, c) => { if (h) obj[h] = row[c] ?? ''; });
    result.push(obj);
  }
  return result;
}

// Builds { byItem: Record<itemNo, { rrp_CR, rrp_NR, rrp_WR }> }
// Handles two file formats:
//   1. Customer Price Group: Sales Code (CR/NR/WR) | Item No. | Unit Price Including VAT
//   2. Specials/Offers file: OfferDescription (-CR/-NR/-WR suffix) | No_ | Standard Price Including VAT
export function buildRrpMap(rows: any[]): {
  byItem: Record<string, Record<string, string>>;
  count: number;
} {
  const byItem: Record<string, Record<string, string>> = {};
  if (!rows.length) return { byItem, count: 0 };

  const norm = (s: string) => s.toLowerCase().replace(/[\s_\-\.]/g, '');
  const firstKeys = Object.keys(rows[0]);

  // Detect file format by checking for Specials-specific columns
  const isSpecialsFormat = firstKeys.some(k => norm(k) === norm('OfferDescription') || norm(k) === norm('Offer No_'));

  const getValExact = (row: any, keys: string[], ...names: string[]) => {
    for (const n of names) {
      const nn = norm(n);
      const k = keys.find(k => norm(k) === nn);
      if (k) return String(row[k] ?? '').trim();
    }
    for (const n of names) {
      const nn = norm(n);
      const matches = keys.filter(k => norm(k).includes(nn)).sort((a, b) => norm(a).length - norm(b).length);
      if (matches.length) return String(row[matches[0]] ?? '').trim();
    }
    return '';
  };

  // UOM suffix helper: '' = EACH, '_6' = INNER6/CASE6, '_12' = CASE12
  function uomSuffix(uom: string): string | null {
    const u = uom.toUpperCase().replace(/[\s\-_]/g, '');
    if (/^(INNER6|CASE6|6PACK|PACK6|6PK|INNERPACK6)$/.test(u) || (u.includes('6') && (u.includes('INNER') || u.includes('CASE') || u.includes('PACK')))) return '_6';
    if (/^(CASE12|12PACK|PACK12|12PK|INNERPACK12)$/.test(u) || (u.includes('12') && (u.includes('CASE') || u.includes('PACK')))) return '_12';
    if (!u || u === 'EACH' || u === 'EA' || u === 'SINGLE' || u === 'UNIT' || u === 'PC' || u === 'PCS') return '';
    return null; // skip unknown UOM (CASE24, etc.)
  }

  // For Customer Price Group: track latest Starting Date per item per compound key (region+uom)
  const latestDate: Record<string, Record<string, Date>> = {};

  for (const row of rows) {
    const keys = Object.keys(row);
    let itemNo = '';
    let price = '';
    let region = '';

    if (isSpecialsFormat) {
      // Specials format has no UOM column — treat all as EACH
      itemNo = getValExact(row, keys, 'No_', 'No.', 'itemno', 'itemnumber').replace(/\.0$/, '').trim();
      price = getValExact(row, keys, 'Standard Price Including VAT', 'standardpriceincludingvat', 'Standard Price', 'standardprice');
      const offerDesc = getValExact(row, keys, 'OfferDescription', 'offerdescription').toUpperCase();
      const priceGroup = getValExact(row, keys, 'Price Group', 'pricegroup').toUpperCase().trim();
      if (/-NR\b/.test(offerDesc) || /\bNR\b/.test(offerDesc) || priceGroup === 'NR') region = 'NR';
      else if (/-CR\b/.test(offerDesc) || /\bCR\b/.test(offerDesc) || priceGroup === 'CR') region = 'CR';
      else if (/-WR\b/.test(offerDesc) || /-W\b/.test(offerDesc) || /\bWR\b/.test(offerDesc) || priceGroup === 'WR') region = 'WR';

      if (!itemNo || !price || !region) continue;
      if (!byItem[itemNo]) byItem[itemNo] = {};
      const k = `rrp_${region}`;
      if (!byItem[itemNo][k]) byItem[itemNo][k] = price;
    } else {
      // Customer Price Group: detect UOM; take the most-recent price per item+region+uom
      itemNo = getValExact(row, keys, 'Item No', 'Item No.', 'itemno', 'itemnumber').replace(/\.0$/, '').trim();
      price = getValExact(row, keys, 'Unit Price Including VAT', 'unitpriceincludingvat', 'Unit Price', 'unitprice');
      region = getValExact(row, keys, 'Sales Code', 'salescode').toUpperCase().trim();
      const uomRaw = getValExact(row, keys, 'Unit of Measure Code', 'unitofmeasurecode', 'UOM', 'uom', 'Unit of Measure', 'unitofmeasure').trim();
      const suffix = uomSuffix(uomRaw);
      const startDate = parseDMY(getValExact(row, keys, 'Starting Date', 'startingdate', 'startdate'));

      if (!itemNo || !price || !region || suffix === null) continue;

      const compoundKey = `rrp_${region}${suffix}`;
      if (!byItem[itemNo]) byItem[itemNo] = {};
      if (!latestDate[itemNo]) latestDate[itemNo] = {};

      const prevDate = latestDate[itemNo][compoundKey];
      const isNewer = !byItem[itemNo][compoundKey]
        || (startDate && (!prevDate || startDate >= prevDate));

      if (isNewer) {
        byItem[itemNo][compoundKey] = price;
        if (startDate) latestDate[itemNo][compoundKey] = startDate;
      }
    }
  }

  return { byItem, count: Object.keys(byItem).length };
}

// ── Specials file parser ───────────────────────────────────────────────────
// Expected columns: Offer No., Status, OfferDescription, Starting Date,
// Ending Date, Line No., Offer Type, No. (item), Variant Code, Description,
// Standard Price Including VAT, Standard Price, Deal Price, Disc., Price Group,
// Priority, Unit of Measure, Disc. Type, Discount Amount, Offer Price, etc.
export async function parseSpecialsFile(file: File): Promise<any[]> {
  let aoa: any[][];
  try { aoa = await readWorksheetAsAoa(file); } catch { return []; }
  if (!Array.isArray(aoa) || aoa.length < 2 || !Array.isArray(aoa[0])) return [];
  const headers = aoa[0].map((c: any) => String(c ?? '').trim());
  const result: any[] = [];
  for (let r = 1; r < aoa.length; r++) {
    const row = aoa[r];
    if (!row || row.every((c: any) => c === '' || c == null)) continue;
    const obj: any = {};
    headers.forEach((h, c) => { if (h) obj[h] = row[c] ?? ''; });
    result.push(obj);
  }
  return result;
}

// Builds specials AND rrp maps from the Offers export file.
// Special price: "Deal Price Value" or "Offer Price Including VAT"
// RRP: "Standard Price Including VAT" — extracted from the same file
// Region: OfferDescription suffix (-CR / -NR / -WR) or Price Group column
function parseDMY(s: any): Date | null {
  if (!s && s !== 0) return null;
  const str = String(s).trim();
  if (!str || str.toUpperCase() === 'NULL') return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(str);
  if (m) return new Date(parseInt(m[3]), parseInt(m[2]) - 1, parseInt(m[1]));
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

function fmtDMY(d: Date | null): string | undefined {
  if (!d) return undefined;
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

export function buildSpecialsMap(rows: any[]): {
  byItem: Record<string, { special_CR?: string; special_CR_start?: string; special_CR_end?: string; special_NR?: string; special_NR_start?: string; special_NR_end?: string; special_WR?: string; special_WR_start?: string; special_WR_end?: string }>;
  rrpByItem: Record<string, { rrp_CR?: string; rrp_NR?: string; rrp_WR?: string }>;
  count: number;
} {
  const byItem: Record<string, { special_CR?: string; special_CR_start?: string; special_CR_end?: string; special_NR?: string; special_NR_start?: string; special_NR_end?: string; special_WR?: string; special_WR_start?: string; special_WR_end?: string }> = {};
  const rrpByItem: Record<string, { rrp_CR?: string; rrp_NR?: string; rrp_WR?: string }> = {};
  // Track the latest ending date seen per item+region so most-recent offer wins
  const specialsLatestEnd: Record<string, { CR?: Date; NR?: Date; WR?: Date }> = {};

  const norm = (s: string) => s.toLowerCase().replace(/[\s_\-\.]/g, '');

  for (const row of rows) {
    const keys = Object.keys(row);

    const getValExact = (...names: string[]) => {
      for (const n of names) {
        const nn = norm(n);
        const k = keys.find(k => norm(k) === nn);
        if (k) return String(row[k] ?? '').trim();
      }
      // substring fallback — shortest match wins
      for (const n of names) {
        const nn = norm(n);
        const matches = keys.filter(k => norm(k).includes(nn)).sort((a, b) => norm(a).length - norm(b).length);
        if (matches.length) return String(row[matches[0]] ?? '').trim();
      }
      return '';
    };

    const itemNo = getValExact('No_', 'No.', 'itemno', 'itemnumber').replace(/\.0$/, '').trim();
    if (!itemNo) continue;

    // Parse dates — NO expiry filter; user uploads current file, all rows are treated as valid
    const startDate = parseDMY(getValExact('Starting Date', 'startingdate', 'startdate'));
    const endDate = parseDMY(getValExact('Ending Date', 'endingdate', 'enddate'));

    const startStr = fmtDMY(startDate);
    const endStr = fmtDMY(endDate);

    // RRP = standard shelf price before the deal
    const stdPrice = getValExact('Standard Price Including VAT', 'standardpriceincludingvat')
      || getValExact('Standard Price', 'standardprice');

    // Deal price: primary = "Offer Price Including VAT" (absolute price in file)
    // Fallback = Standard Price × (1 - Disc%/100) when "Deal Price_Disc_ _" is a discount percentage
    let dealPrice = getValExact('Offer Price Including VAT', 'offerpriceincludingvat')
      || getValExact('Deal Price Value', 'dealpricevalue')
      || getValExact('Offer Price', 'offerprice')
      || getValExact('Deal Price', 'dealprice');

    if ((!dealPrice || parseFloat(dealPrice) <= 0) && stdPrice) {
      const discPct = parseFloat(getValExact('Deal Price_Disc_ _', 'dealpricedisc') || '');
      const std = parseFloat(stdPrice);
      // discPct > 0 and < 100 confirms it is a percentage (not an absolute price or zero)
      if (discPct > 0 && discPct < 100 && std > 0) {
        dealPrice = (std * (1 - discPct / 100)).toFixed(2);
      }
      // Second fallback: Standard Price Inc VAT − Discount Amount Inc VAT
      if ((!dealPrice || parseFloat(dealPrice) <= 0) && std > 0) {
        const discAmtInclVat = parseFloat(getValExact('Discount Amount Including VAT', 'discountamountincludingvat') || '');
        if (discAmtInclVat > 0 && std - discAmtInclVat > 0) {
          dealPrice = (std - discAmtInclVat).toFixed(2);
        }
      }
    }

    // Region from offer description suffix, then Price Group, then Variant Code
    const offerDesc = getValExact('OfferDescription', 'offerdescription', 'offername').toUpperCase();
    const priceGroup = getValExact('Price Group', 'pricegroup').toUpperCase().trim();
    const variantCode = getValExact('Variant Code', 'variantcode').toUpperCase().trim();

    let region = '';
    if (/-NR\b/.test(offerDesc) || /\bNR\b/.test(offerDesc) || priceGroup === 'NR' || variantCode === 'NR') region = 'NR';
    else if (/-CR\b/.test(offerDesc) || /\bCR\b/.test(offerDesc) || priceGroup === 'CR' || variantCode === 'CR') region = 'CR';
    else if (/-WR\b/.test(offerDesc) || /-W\b/.test(offerDesc) || /\bWR\b/.test(offerDesc) || priceGroup === 'WR' || variantCode === 'WR') region = 'WR';

    // If no region could be detected, store under all three regions so item is never silently dropped
    const regions: string[] = region ? [region] : ['CR', 'NR', 'WR'];

    const hasPrice = dealPrice && !isNaN(parseFloat(dealPrice)) && parseFloat(dealPrice) > 0;

    for (const r of regions) {
      if (!byItem[itemNo]) byItem[itemNo] = {};
      // Always record the item. Only write price fields when we have a positive deal price.
      if (hasPrice) {
        if (r === 'CR') {
          byItem[itemNo].special_CR = dealPrice; byItem[itemNo].special_CR_start = startStr; byItem[itemNo].special_CR_end = endStr;
        } else if (r === 'NR') {
          byItem[itemNo].special_NR = dealPrice; byItem[itemNo].special_NR_start = startStr; byItem[itemNo].special_NR_end = endStr;
        } else if (r === 'WR') {
          byItem[itemNo].special_WR = dealPrice; byItem[itemNo].special_WR_start = startStr; byItem[itemNo].special_WR_end = endStr;
        }
      }
    }

    // Store RRP (standard price) — take the first occurrence per item+region
    if (stdPrice) {
      if (!rrpByItem[itemNo]) rrpByItem[itemNo] = {};
      if (region === 'CR' && !rrpByItem[itemNo].rrp_CR) rrpByItem[itemNo].rrp_CR = stdPrice;
      else if (region === 'NR' && !rrpByItem[itemNo].rrp_NR) rrpByItem[itemNo].rrp_NR = stdPrice;
      else if (region === 'WR' && !rrpByItem[itemNo].rrp_WR) rrpByItem[itemNo].rrp_WR = stdPrice;
    }
  }

  const specialsCount = Object.keys(byItem).length;
  const rrpItemCount = Object.keys(rrpByItem).length;
  return { byItem, rrpByItem, count: Math.max(specialsCount, rrpItemCount) };
}

export async function parseSohFile(file: File): Promise<any[]> {
  let aoa: any[][];
  try { aoa = await readWorksheetAsAoa(file); } catch { return []; }
  if (!Array.isArray(aoa) || aoa.length < 2 || !Array.isArray(aoa[0])) return [];
  const headers = aoa[0].map((c: any) => String(c ?? ''));
  const result: any[] = [];
  for (let r = 1; r < aoa.length; r++) {
    const row = aoa[r];
    if (!row || row.every((c: any) => c === '' || c == null)) continue;
    const obj: any = {};
    headers.forEach((h, c) => { if (h) obj[h] = row[c] ?? ''; });
    result.push(obj);
  }
  return result;
}

function parseDateOnly(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value !== 'string') return null;
  const [year, month, day] = value.split('-').map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day);
}

const STATUS_COLORS: Record<string, { fg: string; bg: string }> = {
  Expired:       { fg: 'FFFFFFFF', bg: 'FFB91C1C' },
  Urgent:        { fg: 'FFFFFFFF', bg: 'FFD97706' },
  'Near Expiry': { fg: 'FF1A1A1A', bg: 'FFFBBF24' },
  OK:            { fg: 'FFFFFFFF', bg: 'FF16A34A' },
};

const BORDER_THIN = {
  top:    { style: 'thin' as const, color: { argb: 'FFB0B0B0' } },
  left:   { style: 'thin' as const, color: { argb: 'FFB0B0B0' } },
  bottom: { style: 'thin' as const, color: { argb: 'FFB0B0B0' } },
  right:  { style: 'thin' as const, color: { argb: 'FFB0B0B0' } },
};

const HEADER_FILL = {
  type: 'pattern' as const,
  pattern: 'solid' as const,
  fgColor: { argb: 'FF1C1C1E' },
};

async function addExpirySheet(workbook: any, sheetName: string, data: any[]) {
  const sheet = workbook.addWorksheet(sheetName);
  if (data.length === 0) {
    sheet.addRow(['No data for this category']);
    return;
  }

  const cols = [
    'PD User Name', 'Store Location', 'Barcode', 'Item Number', 'Description',
    'RRP', 'Qty', 'Expiry Date', 'Status', 'Days Left', 'Scan Date', 'Action Required', 'Remarks',
  ];

  const expiryDateIdx = cols.indexOf('Expiry Date');
  const scanDateIdx   = cols.indexOf('Scan Date');
  const daysLeftIdx   = cols.indexOf('Days Left');
  const statusIdx     = cols.indexOf('Status');
  const actionReqIdx  = cols.indexOf('Action Required');

  sheet.columns = cols.map((header) => {
    const maxLen = data.reduce((max, row) => {
      const val = row[header] == null ? '' : String(row[header]);
      return Math.max(max, val.length);
    }, header.length);
    return { header, key: header, width: Math.min(Math.max(maxLen + 3, 12), 38) };
  });

  const headerRow = sheet.getRow(1);
  headerRow.eachCell((cell: any) => {
    cell.fill = HEADER_FILL;
    cell.font = { bold: true, color: { argb: 'FFFBBF24' }, size: 11 };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    cell.border = BORDER_THIN;
    cell.protection = { locked: true };
  });
  headerRow.height = 22;

  const protectedCols = new Set([daysLeftIdx, statusIdx, actionReqIdx].filter(i => i >= 0));

  data.forEach((row, ri) => {
    const excelRow = sheet.addRow(cols.map((h) => row[h]));
    const excelRowNum = ri + 2;

    excelRow.eachCell({ includeEmpty: true }, (cell: any, colNum: number) => {
      const colIdx = colNum - 1;
      cell.border = BORDER_THIN;
      cell.alignment = { vertical: 'middle', horizontal: colIdx === statusIdx ? 'center' : 'left' };
      cell.font = { size: 10 };
      cell.protection = { locked: protectedCols.has(colIdx) };

      if (colIdx === expiryDateIdx || colIdx === scanDateIdx) {
        const date = parseDateOnly(row[cols[colIdx]]);
        if (date) { cell.value = date; cell.numFmt = 'dd/mm/yyyy'; }
      }

      if (colIdx === daysLeftIdx && expiryDateIdx >= 0) {
        const expiryCell = sheet.getCell(excelRowNum, expiryDateIdx + 1).address;
        cell.value = { formula: `${expiryCell}-TODAY()`, result: row['Days Left'] ?? 0 };
        cell.numFmt = '0';
        cell.alignment = { ...cell.alignment, horizontal: 'center' };
        cell.font = { size: 10, italic: true, color: { argb: 'FF374151' } };
      }

      if (colIdx === statusIdx && daysLeftIdx >= 0) {
        const daysCell = sheet.getCell(excelRowNum, daysLeftIdx + 1).address;
        cell.value = {
          formula: `IF(${daysCell}<0,"Expired",IF(${daysCell}<=2,"Urgent",IF(${daysCell}<=15,"Near Expiry","OK")))`,
          result: row['Status'] ?? 'OK',
        };
        const colors = STATUS_COLORS[row['Status'] as string] ?? STATUS_COLORS['OK'];
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors.bg } };
        cell.font = { bold: true, color: { argb: colors.fg }, size: 10 };
      }

      if (colIdx === actionReqIdx && daysLeftIdx >= 0) {
        const daysCell = sheet.getCell(excelRowNum, daysLeftIdx + 1).address;
        cell.value = {
          formula: `IF(${daysCell}<0,"Remove from shelf",IF(${daysCell}<=2,"Immediate review / markdown",IF(${daysCell}<=15,"Monitor / markdown","No action required")))`,
          result: row['Action Required'] ?? 'No action required',
        };
        cell.font = { size: 10, italic: true, color: { argb: 'FF374151' } };
      }
    });

    excelRow.height = 18;
  });

  await sheet.protect('', {
    selectLockedCells: true,
    selectUnlockedCells: true,
    formatCells: true,
    formatColumns: true,
    formatRows: true,
    insertRows: true,
    insertColumns: true,
    insertHyperlinks: true,
    deleteRows: true,
    deleteColumns: true,
    sort: true,
    autoFilter: true,
    pivotTables: true,
  });

  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: data.length + 1, column: cols.length } };
  sheet.views = [{ state: 'frozen', xSplit: 0, ySplit: 1 }];
}

async function addSimpleSheet(workbook: any, sheetName: string, data: any[], cols: string[], dateCols: string[] = []) {
  const sheet = workbook.addWorksheet(sheetName);
  if (data.length === 0) {
    sheet.addRow(['No data for this category']);
    return;
  }

  sheet.columns = cols.map((header) => {
    const maxLen = data.reduce((max, row) => {
      const val = row[header] == null ? '' : String(row[header]);
      return Math.max(max, val.length);
    }, header.length);
    return { header, key: header, width: Math.min(Math.max(maxLen + 3, 12), 40) };
  });

  const headerRow = sheet.getRow(1);
  headerRow.eachCell((cell: any) => {
    cell.fill = HEADER_FILL;
    cell.font = { bold: true, color: { argb: 'FFFBBF24' }, size: 11 };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    cell.border = BORDER_THIN;
  });
  headerRow.height = 22;

  data.forEach((row) => {
    const excelRow = sheet.addRow(cols.map((h) => row[h]));
    excelRow.eachCell({ includeEmpty: true }, (cell: any, colNum: number) => {
      const colIdx = colNum - 1;
      cell.border = BORDER_THIN;
      cell.alignment = { vertical: 'middle', horizontal: 'left' };
      cell.font = { size: 10 };

      if (dateCols.includes(cols[colIdx])) {
        const date = parseDateOnly(row[cols[colIdx]]);
        if (date) { cell.value = date; cell.numFmt = 'dd/mm/yyyy'; }
      }

      if (typeof row[cols[colIdx]] === 'number' && ['RRP', 'Special Price', 'System SOH', 'Bulk Pull Qty'].includes(cols[colIdx])) {
        cell.numFmt = '#,##0.00';
        cell.alignment = { vertical: 'middle', horizontal: 'right' };
      }
    });
    excelRow.height = 18;
  });

  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: data.length + 1, column: cols.length } };
  sheet.views = [{ state: 'frozen', xSplit: 0, ySplit: 1 }];
}

export async function exportToExcel(allScans: any[], filename: string): Promise<string | null> {
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  workbook.calcProperties.fullCalcOnLoad = true;

  const expiryScans = allScans.filter(s => {
    if (s['Status'] === 'OK') return false;
    const isComplianceOnly = (s['_wrongRrp'] || s['_missingSpecialTicket'] || s['_notOnDisplay'])
      && s['Expiry Date'] === s['Scan Date'];
    return !isComplianceOnly;
  });

  const rrpScans = allScans.filter(s => s['_wrongRrp'] === true);
  const specialScans = allScans.filter(s => s['_missingSpecialTicket'] === true);
  const notOnDisplayScans = allScans.filter(s => s['_notOnDisplay'] === true);

  await addExpirySheet(workbook, 'Expiry Scans', expiryScans);

  await addSimpleSheet(
    workbook, 'RRP Scans', rrpScans,
    ['PD User Name', 'Store Location', 'Barcode', 'Item Number', 'Description', 'RRP', 'Qty', 'Scan Date', 'Remarks'],
    ['Scan Date'],
  );

  await addSimpleSheet(
    workbook, 'Special Ticket Scans', specialScans,
    ['PD User Name', 'Store Location', 'Barcode', 'Item Number', 'Description', 'Special Price', 'Qty', 'Scan Date', 'Remarks'],
    ['Scan Date'],
  );

  await addSimpleSheet(
    workbook, 'Not On Display', notOnDisplayScans,
    ['PD User Name', 'Store Location', 'Barcode', 'Item Number', 'Description', 'System SOH', 'Bulk Pull Qty', 'Scan Date', 'Remarks'],
    ['Scan Date'],
  );

  const buf = await workbook.xlsx.writeBuffer() as ArrayBuffer;

  const bytes = new Uint8Array(buf);
  let binary = '';
  bytes.forEach(b => { binary += String.fromCharCode(b); });
  return btoa(binary);
}

function downloadBuffer(buf: ArrayBuffer, filename: string) {
  const blob = new Blob([buf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filename}.xlsx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
