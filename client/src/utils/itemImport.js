// Read ledger items from Excel (.xlsx), CSV, text (.txt / .tsv) or Word (.docx) files, and export items
// to Excel in the same column layout (so an exported file can be edited and imported back).
import { cellText, parseCsv, parseDelimited, excelRows, docxContent, downloadExcel } from './fileTable.js';

/** Item field → headings that mean it (compared lower-case, letters and digits only). */
const ALIASES = {
  code: ['itemcode', 'code', 'itemno', 'itemnumber', 'codeno', 'partno', 'sku'],
  name: ['itemname', 'name', 'item', 'nomenclature', 'particulars', 'nameofitem', 'nameofstore', 'nameofstores', 'store', 'stores', 'article', 'articlename', 'product', 'productname', 'material', 'materialname'],
  description: ['description', 'itemdescription', 'desc', 'details', 'specification', 'specifications', 'spec', 'size', 'make', 'model'],
  ledger: ['ledger', 'typeofstore', 'typeofstoreledger', 'store', 'storetype', 'ledgername', 'ledgertype'],
  uom: ['uom', 'au', 'unit', 'units', 'unitofmeasure', 'unitofmeasurement', 'accountingunit'],
  ledgerPage: ['ledgerpage', 'ledgerpageno', 'ledgerpg', 'pageno', 'page', 'lpno', 'ledgerfolio', 'folio', 'folioNo'],
  category: ['category', 'type', 'itemtype', 'consumable', 'consumablenonconsumable'],
  minStock: ['minstock', 'minimumstock', 'minqty', 'minimumqty', 'reorderlevel', 'reorderqty'],
  status: ['status', 'active'],
};
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
// "store" alone is ambiguous; it means the item name only when no other column already does.
const FIELD_OF = new Map(Object.entries(ALIASES).flatMap(([f, names]) => names.filter((n) => !(f === 'ledger' && n === 'store')).map((n) => [norm(n), f])));
const fieldFor = (h) => FIELD_OF.get(norm(h));
const SKIP_NAME = /^(total|grand total|sl\.?\s*no|s\.?\s*no)\b/i;

/** Rows → item records, using the first row (within the top 15) that has an item-name heading. */
function rowsToItems(rows) {
  const headerIdx = rows.slice(0, 15).findIndex((r) => r.map(fieldFor).includes('name'));
  if (headerIdx < 0) {
    // No headings: a plain list — first column is the item name, second (if any) the UoM.
    return rows
      .map((r) => r.map((c) => String(cellText(c)).trim()))
      .filter((r) => r[0] && !SKIP_NAME.test(r[0]))
      .map((r) => ({ name: r[0], ...(r[1] ? { uom: r[1] } : {}) }));
  }
  const fields = rows[headerIdx].map(fieldFor);
  return rows
    .slice(headerIdx + 1)
    .map((row) =>
      Object.fromEntries(
        fields
          .map((f, i) => [f, cellText(row[i])])
          .filter(([f, v]) => f && v !== '' && v != null)
          .map(([f, v]) => [f, f === 'minStock' ? v : String(v instanceof Date ? v.toISOString().slice(0, 10) : v).trim()]),
      ),
    )
    .filter((r) => (r.name || r.code) && !SKIP_NAME.test(r.name || ''));
}

/** Read one file → item records (not yet saved). */
export async function readItemFile(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.xlsx')) {
    const sheets = await excelRows(await file.arrayBuffer());
    return sheets.flatMap((rows) => (rows.length ? rowsToItems(rows) : []));
  }
  if (name.endsWith('.csv')) return rowsToItems(parseCsv(await file.text()));
  if (name.endsWith('.txt') || name.endsWith('.tsv')) return rowsToItems(parseDelimited(await file.text()));
  if (name.endsWith('.docx')) {
    const { tables, paragraphs } = await docxContent(await file.arrayBuffer());
    const withHead = tables.filter((t) => t.slice(0, 15).some((r) => r.map(fieldFor).includes('name')));
    if (withHead.length) return withHead.flatMap(rowsToItems);
    if (tables.length) return tables.flatMap(rowsToItems);
    return rowsToItems(paragraphs.map((p) => p.split(/\t|\s{2,}|\s*[|,]\s*/)));
  }
  if (name.endsWith('.xls') || name.endsWith('.doc')) throw new Error(`"${file.name}": old Office format. Open it and "Save As" .xlsx / .docx, then import.`);
  if (name.endsWith('.pdf')) throw new Error(`"${file.name}": PDF cannot be read directly. Open it in Word / Excel and save as .docx / .xlsx, then import.`);
  throw new Error(`"${file.name}": use an Excel (.xlsx), CSV, text (.txt) or Word (.docx) file.`);
}

/** Columns of the import template / export. */
export const ITEM_COLUMNS = [
  ['code', 'Item Code', 12], ['name', 'Item Name', 32], ['description', 'Description', 32], ['ledger', 'Ledger', 18],
  ['uom', 'UoM', 10], ['ledgerPage', 'Ledger Page No', 14], ['category', 'Category', 16], ['minStock', 'Min Stock', 10],
  ['status', 'Status', 10], ['currentStock', 'Current Stock (info only)', 14],
];

/** Download items (or an empty template) as Excel in the import layout. */
export function downloadItemsExcel(items, filename, ledgerLabel = (k) => k) {
  const rows = items.map((i) => ({
    ...i,
    ledger: ledgerLabel(i.ledger),
    category: i.category === 'CONSUMABLE' ? 'Consumable' : 'Non-Consumable',
    status: i.status === 'INACTIVE' ? 'Inactive' : 'Active',
  }));
  return downloadExcel(ITEM_COLUMNS, rows, filename, 'Items');
}
