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

export async function exportToExcel(data: any[], filename: string) {
  const ExcelJS = (await import('exceljs')).default;

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

  const workbook = new ExcelJS.Workbook();
  workbook.calcProperties.fullCalcOnLoad = true;

  const sheet = workbook.addWorksheet('Expiry Scans');

  if (data.length === 0) {
    const buf = await workbook.xlsx.writeBuffer();
    downloadBuffer(buf, filename);
    return;
  }

  const headers = Object.keys(data[0]);
  const expiryDateIdx  = headers.indexOf('Expiry Date');
  const scanDateIdx    = headers.indexOf('Scan Date');
  const daysLeftIdx    = headers.indexOf('Days Left');
  const statusIdx      = headers.indexOf('Status');
  const actionReqIdx   = headers.indexOf('Action Required');

  sheet.columns = headers.map((header) => {
    const maxLen = data.reduce((max, row) => {
      const val = row[header] == null ? '' : String(row[header]);
      return Math.max(max, val.length);
    }, header.length);
    return { header, key: header, width: Math.min(Math.max(maxLen + 3, 12), 38) };
  });

  const headerRow = sheet.getRow(1);
  headerRow.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.font = { bold: true, color: { argb: 'FFFBBF24' }, size: 11 };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    cell.border = BORDER_THIN;
    cell.protection = { locked: false };
  });
  headerRow.height = 22;

  const protectedCols = new Set([daysLeftIdx, statusIdx, actionReqIdx].filter(i => i >= 0));

  data.forEach((row, ri) => {
    const excelRow = sheet.addRow(headers.map((h) => row[h]));
    const excelRowNum = ri + 2;

    excelRow.eachCell({ includeEmpty: true }, (cell, colNum) => {
      const colIdx = colNum - 1;
      const isProtected = protectedCols.has(colIdx);

      cell.border = BORDER_THIN;
      cell.alignment = { vertical: 'middle', horizontal: colIdx === statusIdx ? 'center' : 'left' };
      cell.font = { size: 10 };
      cell.protection = { locked: isProtected };

      if (colIdx === expiryDateIdx || colIdx === scanDateIdx) {
        const date = parseDateOnly(row[headers[colIdx]]);
        if (date) {
          cell.value = date;
          cell.numFmt = 'dd/mm/yyyy';
        }
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
        cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors.bg } };
        cell.font  = { bold: true, color: { argb: colors.fg }, size: 10 };
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
    selectLockedCells:   true,
    selectUnlockedCells: true,
    formatCells:         true,
    formatColumns:       true,
    formatRows:          true,
    insertRows:          false,
    deleteRows:          false,
    sort:                true,
    autoFilter:          true,
  });

  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to:   { row: data.length + 1, column: headers.length },
  };

  sheet.views = [{ state: 'frozen', xSplit: 0, ySplit: 1 }];

  const buf = await workbook.xlsx.writeBuffer();
  downloadBuffer(buf, filename);
}

function downloadBuffer(buf: ArrayBuffer | Buffer, filename: string) {
  const blob = new Blob([buf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = `${filename}.xlsx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
