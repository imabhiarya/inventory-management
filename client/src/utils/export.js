// Table export helpers. Heavy libraries are loaded on demand to keep the main bundle small.
// columns: [{ key, label, align?: 'right', format?: (value, row) => string }]

const cell = (col, row) => {
  const v = typeof col.value === 'function' ? col.value(row) : row[col.key];
  return col.format ? col.format(v, row) : v ?? '';
};

export async function exportExcel({ title, subtitle, columns, rows, filename, footer }) {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet((title || 'Report').slice(0, 31).replace(/[\\/?*[\]:]/g, '-'));
  const span = columns.length;
  ws.mergeCells(1, 1, 1, span);
  ws.getCell(1, 1).value = title;
  ws.getCell(1, 1).font = { bold: true, size: 14 };
  let r = 2;
  if (subtitle) {
    ws.mergeCells(2, 1, 2, span);
    ws.getCell(2, 1).value = subtitle;
    r = 3;
  }
  r += 1;
  const header = ws.getRow(r);
  columns.forEach((c, i) => {
    const h = header.getCell(i + 1);
    h.value = c.label;
    h.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    h.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B2C66' } };
    h.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  });
  for (const row of rows) {
    r += 1;
    columns.forEach((c, i) => {
      const raw = typeof c.value === 'function' ? c.value(row) : row[c.key];
      // Keep numbers numeric in Excel so they can be summed.
      ws.getRow(r).getCell(i + 1).value = c.numeric && raw !== null && raw !== '' && raw !== undefined ? Number(raw) : cell(c, row);
    });
  }
  if (footer) {
    r += 1;
    columns.forEach((c, i) => {
      const v = footer[c.key];
      if (v !== undefined) {
        const fc = ws.getRow(r).getCell(i + 1);
        fc.value = v;
        fc.font = { bold: true };
      }
    });
  }
  columns.forEach((c, i) => {
    ws.getColumn(i + 1).width = c.width || Math.min(45, Math.max(10, c.label.length + 4));
  });
  const buf = await wb.xlsx.writeBuffer();
  download(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${filename}.xlsx`);
}

// Page margins for every print and PDF (also the @page rule in styles.css), in mm.
export const PRINT_MARGIN_MM = { top: 14, right: 15.5, bottom: 13.5, left: 22 };
const MM = 72 / 25.4; // points per mm

export async function exportPdf({ title, subtitle, columns, rows, filename, footer, orgTitle, orgSubtitle, orientation }) {
  const [{ jsPDF }, { autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  const doc = new jsPDF({ orientation: orientation || (columns.length > 6 ? 'landscape' : 'portrait'), unit: 'pt', format: 'a4' });
  const w = doc.internal.pageSize.getWidth();
  const m = Object.fromEntries(Object.entries(PRINT_MARGIN_MM).map(([k, v]) => [k, v * MM]));
  const cx = m.left + (w - m.left - m.right) / 2; // centre of the printable width
  const y = m.top + 10; // first line's baseline, just inside the top margin
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.text(orgTitle || '', cx, y, { align: 'center' });
  doc.setFontSize(10);
  doc.text(orgSubtitle || '', cx, y + 16, { align: 'center' });
  doc.setFontSize(12);
  doc.text(title, cx, y + 38, { align: 'center' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  if (subtitle) doc.text(subtitle, cx, y + 54, { align: 'center' });
  // jsPDF's built-in fonts lack the rupee glyph.
  const clean = (s) => String(s ?? '').replace(/₹/g, 'Rs.');
  autoTable(doc, {
    startY: y + 64,
    margin: { top: m.top, right: m.right, bottom: m.bottom + 14, left: m.left },
    head: [columns.map((c) => clean(c.label))],
    body: rows.map((r) => columns.map((c) => clean(cell(c, r)))),
    foot: footer ? [columns.map((c) => clean(footer[c.key] ?? ''))] : undefined,
    styles: { fontSize: 8, cellPadding: 3 },
    headStyles: { fillColor: [11, 44, 102], halign: 'center' },
    footStyles: { fillColor: [214, 240, 190], textColor: 20, fontStyle: 'bold' },
    columnStyles: Object.fromEntries(columns.map((c, i) => [i, { halign: c.align || 'left' }])),
    didDrawPage: () => {
      const h = doc.internal.pageSize.getHeight();
      doc.setFontSize(8);
      doc.text(`Generated ${new Date().toLocaleString('en-IN')}`, m.left, h - m.bottom);
      doc.text(`Page ${doc.getNumberOfPages()}`, w - m.right, h - m.bottom, { align: 'right' });
    },
  });
  doc.save(`${filename}.pdf`);
}

export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Print only the element with the given id: it is cloned into #print-root (see styles.css). */
/**
 * The browser prints the page title ("Store Inventory Management System") at the top of every printed page. Blank it
 * (with an invisible character — an empty title makes Chrome print the address instead) while printing.
 */
const HIDDEN_TITLE = '\u200B';
let savedTitle = null;
export function hideTitleForPrint() {
  if (savedTitle === null) savedTitle = document.title;
  document.title = HIDDEN_TITLE;
}
export function restoreTitleAfterPrint() {
  if (savedTitle !== null) document.title = savedTitle;
  savedTitle = null;
}
// Also covers printing with Ctrl+P / the browser menu.
window.addEventListener('beforeprint', hideTitleForPrint);
window.addEventListener('afterprint', restoreTitleAfterPrint);

/**
 * Print one section of the page. `orientation` ('portrait' | 'landscape') overrides the A4 portrait page for
 * this print only; without it the stylesheet's A4 portrait applies.
 */
export function printSection(id, { orientation } = {}) {
  const el = document.getElementById(id);
  if (!el) return;
  document.getElementById('print-page-size')?.remove();
  const pageStyle = orientation ? document.createElement('style') : null;
  if (pageStyle) {
    pageStyle.id = 'print-page-size';
    pageStyle.textContent = `@media print { @page { size: A4 ${orientation}; } }`;
    document.head.appendChild(pageStyle);
  }
  document.getElementById('print-root')?.remove();
  const root = document.createElement('div');
  root.id = 'print-root';
  root.appendChild(el.cloneNode(true));
  document.body.appendChild(root);
  document.body.classList.add('printing');
  const done = () => {
    root.remove();
    pageStyle?.remove();
    document.body.classList.remove('printing');
    window.removeEventListener('afterprint', done);
  };
  window.addEventListener('afterprint', done);
  hideTitleForPrint(); // set before print() so the title is already blank when the page is laid out
  window.print();
}
