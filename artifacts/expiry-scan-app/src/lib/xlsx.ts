export async function parseBarcodeMaster(file: File): Promise<any[]> {
  const xlsx = await import('xlsx');
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = e.target?.result;
        const workbook = xlsx.read(data, { type: 'array' });
        const firstSheet = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheet];
        const json = xlsx.utils.sheet_to_json(worksheet);
        resolve(json as any[]);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

export async function parseSohFile(file: File): Promise<any[]> {
  const xlsx = await import('xlsx');
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = e.target?.result;
        const workbook = xlsx.read(data, { type: 'array' });
        const firstSheet = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheet];
        const json = xlsx.utils.sheet_to_json(worksheet);
        resolve(json as any[]);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
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
    selectLockedCells: true, selectUnlockedCells: true,
    formatCells: true, formatColumns: true, formatRows: true,
    insertRows: false, deleteRows: false, sort: true, autoFilter: true,
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

  // Sheet 1: Expiry Scans — items with real expiry issues (not OK).
  // Exclude compliance-only scans (no real expiry date entered, defaulted to scan date).
  const expiryScans = allScans.filter(s => {
    if (s['Status'] === 'OK') return false;
    const isComplianceOnly = (s['_wrongRrp'] || s['_missingSpecialTicket'] || s['_notOnDisplay'])
      && s['Expiry Date'] === s['Scan Date'];
    return !isComplianceOnly;
  });

  // Sheet 2: RRP Scans — items flagged as having wrong RRP on shelf
  const rrpScans = allScans.filter(s => s['_wrongRrp'] === true);

  // Sheet 3: Special Ticket Scans — items missing special ticket
  const specialScans = allScans.filter(s => s['_missingSpecialTicket'] === true);

  // Sheet 4: Not On Display — system SOH exists but not on shelf
  const notOnDisplayScans = allScans.filter(s => s['_notOnDisplay'] === true);

  await addExpirySheet(workbook, 'Expiry Scans', expiryScans);

  await addSimpleSheet(
    workbook, 'RRP Scans', rrpScans,
    ['PD User Name', 'Store Location', 'Barcode', 'Item Number', 'Description', 'RRP', 'Scan Date', 'Remarks'],
    ['Scan Date'],
  );

  await addSimpleSheet(
    workbook, 'Special Ticket Scans', specialScans,
    ['PD User Name', 'Store Location', 'Barcode', 'Item Number', 'Description', 'Special Price', 'Scan Date', 'Remarks'],
    ['Scan Date'],
  );

  await addSimpleSheet(
    workbook, 'Not On Display', notOnDisplayScans,
    ['PD User Name', 'Store Location', 'Barcode', 'Item Number', 'Description', 'System SOH', 'Bulk Pull Qty', 'Scan Date', 'Remarks'],
    ['Scan Date'],
  );

  const buf = await workbook.xlsx.writeBuffer() as ArrayBuffer;
  downloadBuffer(buf, filename);

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
