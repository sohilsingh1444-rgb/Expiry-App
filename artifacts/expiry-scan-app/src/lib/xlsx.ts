import * as xlsx from 'xlsx';

export async function parseBarcodeMaster(file: File): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = e.target?.result;
        const workbook = xlsx.read(data, { type: 'array' });
        const firstSheet = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheet];
        const json = xlsx.utils.sheet_to_json(worksheet);
        resolve(json);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

function parseDateOnly(value: unknown) {
  if (value instanceof Date) return value;
  if (typeof value !== "string") return null;

  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return null;

  return new Date(year, month - 1, day);
}

export function exportToExcel(data: any[], filename: string) {
  const worksheet = xlsx.utils.json_to_sheet(data);
  const headers = data.length > 0 ? Object.keys(data[0]) : [];
  const expiryDateColumn = headers.indexOf("Expiry Date");
  const scanDateColumn = headers.indexOf("Scan Date");
  const daysLeftColumn = headers.indexOf("Days Left");

  for (let rowIndex = 1; rowIndex <= data.length; rowIndex += 1) {
    for (const columnIndex of [expiryDateColumn, scanDateColumn]) {
      if (columnIndex < 0) continue;

      const address = xlsx.utils.encode_cell({ r: rowIndex, c: columnIndex });
      const date = parseDateOnly(data[rowIndex - 1][headers[columnIndex]]);

      if (date) {
        worksheet[address] = {
          t: "d",
          v: date,
          z: "dd/mm/yyyy",
        };
      }
    }

    if (expiryDateColumn >= 0 && daysLeftColumn >= 0) {
      const daysLeftAddress = xlsx.utils.encode_cell({ r: rowIndex, c: daysLeftColumn });
      const expiryDateAddress = xlsx.utils.encode_cell({ r: rowIndex, c: expiryDateColumn });

      worksheet[daysLeftAddress] = {
        t: "n",
        f: `${expiryDateAddress}-TODAY()`,
        v: data[rowIndex - 1]["Days Left"] ?? 0,
        z: "0",
      };
    }
  }

  worksheet["!cols"] = headers.map((header) => {
    const maxContentLength = data.reduce((max, row) => {
      const value = row[header] == null ? "" : String(row[header]);
      return Math.max(max, value.length);
    }, header.length);

    return { wch: Math.min(Math.max(maxContentLength + 2, 12), 35) };
  });

  if (headers.length > 0) {
    worksheet["!autofilter"] = {
      ref: xlsx.utils.encode_range({
        s: { r: 0, c: 0 },
        e: { r: data.length, c: headers.length - 1 },
      }),
    };
    worksheet["!freeze"] = { xSplit: 0, ySplit: 1 };
  }

  const workbook = xlsx.utils.book_new();
  workbook.Workbook = { CalcPr: { fullCalcOnLoad: true } };
  xlsx.utils.book_append_sheet(workbook, worksheet, "Expiry Scans");
  xlsx.writeFile(workbook, `${filename}.xlsx`);
}
