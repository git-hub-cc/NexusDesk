import type { WorkSheet, utils as XlsxUtils } from "@e965/xlsx";

interface SpreadsheetRow {
  index: number;
  cells: Record<number, string>;
  searchValues: string[];
}

export function prepareSpreadsheetPreview(worksheet: WorkSheet | undefined, utils: typeof XlsxUtils) {
  if (!worksheet?.["!ref"]) return { rows: [] as SpreadsheetRow[], columns: 0, truncated: false };
  const range = utils.decode_range(worksheet["!ref"]);
  const truncated = range.e.r > 99999 || range.e.c > 255;
  const lastRow = Math.min(range.e.r, 99999);
  const lastColumn = Math.min(range.e.c, 255);
  const rows: SpreadsheetRow[] = Array.from({ length: lastRow + 1 }, (_, index) => ({
    index, cells: {}, searchValues: [],
  }));
  // 只遍历已有单元格，避免为稀疏工作表填充数千万个空值。
  for (const address of Object.keys(worksheet)) {
    if (address.startsWith("!")) continue;
    const { r, c } = utils.decode_cell(address);
    if (r > lastRow || c > lastColumn) continue;
    const cell = worksheet[address];
    if (!cell || cell.t === "z") continue;
    const value = utils.format_cell(cell);
    rows[r].cells[c] = value;
    if (value) rows[r].searchValues.push(value.toLocaleLowerCase());
  }
  return { rows, columns: lastColumn + 1, truncated };
}

export function filterSpreadsheetRows<T extends { searchValues: string[] }>(rows: T[], query: string): T[] {
  const search = query.trim().toLocaleLowerCase();
  return search ? rows.filter(row => row.searchValues.some(value => value.includes(search))) : rows;
}
