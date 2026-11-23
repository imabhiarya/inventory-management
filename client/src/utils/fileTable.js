// Shared readers that turn an uploaded file into rows of cell values (Excel, CSV / text, Word tables),
// and a helper to download rows as an Excel file. Used by the Orders and Master Ledger imports.

/** An ExcelJS cell value (formula, rich text, hyperlink …) → plain value. */
export const cellText = (v) => {
  if (v == null) return '';
  if (v instanceof Date) return v;
  if (typeof v === 'object') return v.result ?? v.text ?? (v.richText ? v.richText.map((r) => r.text).join('') : '');
  return v;
};

/** CSV text → rows (quoted cells, "" escapes, CRLF). `sep` defaults to comma. */
export function parseCsv(text, sep = ',') {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) row.push(cell), (cell = '');
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell || row.length) rows.push([...row, cell]);
  return rows.filter((r) => r.some((c) => String(c).trim()));
}

/** Text file: tab-, semicolon- or comma-separated (whichever the first line uses most). */
export function parseDelimited(text) {
  const first = text.split(/\r?\n/).find((l) => l.trim()) || '';
  const count = (c) => first.split(c).length - 1;
  const sep = ['\t', ';', ','].sort((a, b) => count(b) - count(a))[0];
  return parseCsv(text, count(sep) ? sep : '\t');
}

/** Rows of every sheet of an .xlsx file (sheets one after another). */
export async function excelRows(buffer) {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  if (!wb.worksheets.length) throw new Error('The Excel file has no sheet.');
  return wb.worksheets.map((ws) => {
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row) => rows.push(row.values.slice(1).map(cellText)));
    return rows;
  });
}

/** Word (.docx): each table as rows of cell text, plus the plain paragraphs outside tables. */
export async function docxContent(buffer) {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file('word/document.xml')?.async('string');
  if (!xml) throw new Error('This does not look like a Word (.docx) document.');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const textOf = (el) => [...el.getElementsByTagNameNS(W, 't')].map((t) => t.textContent).join('');
  const tables = [...doc.getElementsByTagNameNS(W, 'tbl')].map((tbl) =>
    [...tbl.getElementsByTagNameNS(W, 'tr')].map((tr) => [...tr.getElementsByTagNameNS(W, 'tc')].map(textOf)),
  );
  const paragraphs = [...doc.getElementsByTagNameNS(W, 'p')]
    .filter((p) => !hasAncestor(p, W, 'tbl'))
    .map(textOf)
    .filter((t) => t.trim());
  return { tables, paragraphs };
}
function hasAncestor(el, ns, name) {
  for (let n = el.parentNode; n; n = n.parentNode) if (n.namespaceURI === ns && n.localName === name) return true;
  return false;
}

/** Download `rows` (objects) as an .xlsx with `columns` = [[key, header, width?], …]. */
export async function downloadExcel(columns, rows, filename, sheet = 'Sheet1') {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheet);
  ws.columns = columns.map(([key, header, width]) => ({ header, key, width: width || Math.max(12, header.length + 2) }));
  ws.getRow(1).font = { bold: true };
  for (const r of rows) ws.addRow(r);
  const buf = await wb.xlsx.writeBuffer();
  const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
