// Full backup as an Excel workbook, and back again, so it can be opened in Excel and restored later.
//
//   "Backup Info"   format, version, when and by whom (read on restore)
//   one sheet per collection (items, receipts, issues …): one row per record, one column per field.
//                   Fields holding lists or groups (voucher lines, ledger rows …) are JSON text; their
//                   column headers are listed on the hidden "_json" sheet so they are read back as JSON.
//   "attachments"   attached files (audit / DCS quotations), base64 in pieces of PART characters.
// Restoring the workbook rebuilds exactly the JSON backup the server takes.

const FORMAT = 'mes-store-backup';
const INFO = 'Backup Info';
const JSON_SHEET = '_json';
const FILES = 'attachments';
const PART = 30000; // an Excel cell holds at most 32,767 characters
const MAX_CELL = 32767;

const isPlain = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v);

/** Backup object (as from GET /api/backup) → .xlsx bytes. */
export async function backupToExcel(backup) {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Store Inventory Management System';

  const info = wb.addWorksheet(INFO);
  info.columns = [{ width: 18 }, { width: 70 }];
  info.addRows([
    ['Format', backup.format],
    ['Version', backup.version],
    ['Created At', backup.createdAt],
    ['Created By', backup.createdBy || ''],
    [],
    ['Note', 'Keep sheet names and header rows as they are. Grey header columns hold JSON text; edit them with care.'],
    ['Note', 'Restore this file on Backup & Restore → Choose backup file. Restoring replaces ALL data.'],
  ]);
  info.getColumn(1).font = { bold: true };

  const jsonCols = [];
  for (const [key, docs] of Object.entries(backup.data)) {
    const ws = wb.addWorksheet(key);
    const cols = ['_id', ...new Set(docs.flatMap((d) => Object.keys(d)).filter((c) => c !== '_id'))];
    const json = new Set(cols.filter((c) => docs.some((d) => d[c] !== undefined && !isPlain(d[c]))));
    ws.columns = cols.map((c) => ({ header: c, key: c, width: json.has(c) ? 40 : Math.min(Math.max(c.length + 2, 12), 30) }));
    for (const d of docs) {
      const row = {};
      for (const c of cols) {
        const v = d[c];
        if (v === undefined || v === null) continue;
        row[c] = json.has(c) ? JSON.stringify(v) : v;
        if (typeof row[c] === 'string' && row[c].length > MAX_CELL) {
          throw new Error(`"${key}" record ${d._id}: field "${c}" is too long for an Excel cell. Use Download Backup (JSON) instead.`);
        }
      }
      ws.addRow(row);
    }
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    cols.forEach((c, i) => {
      if (json.has(c)) {
        ws.getRow(1).getCell(i + 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } };
        jsonCols.push([key, c]);
      }
    });
  }

  const files = wb.addWorksheet(FILES);
  files.columns = ['_id', 'filename', 'metadata', 'uploadDate', 'part', 'data'].map((c) => ({ header: c, key: c, width: c === 'data' ? 60 : 24 }));
  files.getRow(1).font = { bold: true };
  for (const f of backup.files || []) {
    const parts = Math.max(1, Math.ceil(f.data.length / PART));
    for (let p = 0; p < parts; p++) {
      files.addRow({
        _id: String(f._id),
        filename: f.filename,
        metadata: f.metadata ? JSON.stringify(f.metadata) : '',
        uploadDate: f.uploadDate || '',
        part: p + 1,
        data: f.data.slice(p * PART, (p + 1) * PART),
      });
    }
  }

  const meta = wb.addWorksheet(JSON_SHEET, { state: 'hidden' });
  meta.addRow(['sheet', 'column']);
  meta.addRows(jsonCols);

  return wb.xlsx.writeBuffer();
}

/** Plain value of a cell as written (Excel may turn edited text into dates, rich text or formulas). */
function cellValue(v) {
  if (v === null || v === undefined) return undefined;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('');
    if ('result' in v) return cellValue(v.result);
    if ('text' in v) return v.text;
  }
  return v;
}

function sheetRows(ws) {
  const header = [];
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    const values = row.values.slice(1).map(cellValue);
    if (n === 1) header.push(...values.map((h) => String(h ?? '').trim()));
    else rows.push(Object.fromEntries(header.map((h, i) => [h, values[i]]).filter(([h, v]) => h && v !== undefined && v !== '')));
  });
  return rows;
}

/** .xlsx bytes made by backupToExcel → backup object for POST /api/backup/restore. */
export async function excelToBackup(buffer) {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch {
    throw new Error('The file could not be read as an Excel workbook.');
  }
  const info = wb.getWorksheet(INFO);
  if (!info) throw new Error('This Excel file is not a backup from this software (no "Backup Info" sheet).');
  const infoMap = {};
  info.eachRow((row) => {
    const [k, v] = row.values.slice(1).map(cellValue);
    if (k && !(k in infoMap)) infoMap[k] = v;
  });
  if (infoMap.Format !== FORMAT) throw new Error('This Excel file is not a backup from this software.');

  const json = new Set();
  const meta = wb.getWorksheet(JSON_SHEET);
  meta?.eachRow((row, n) => {
    if (n > 1) json.add(row.values.slice(1).map(cellValue).join('\u0000'));
  });

  const data = {};
  for (const ws of wb.worksheets) {
    if ([INFO, JSON_SHEET, FILES].includes(ws.name)) continue;
    data[ws.name] = sheetRows(ws).map((r, i) => {
      for (const [c, v] of Object.entries(r)) {
        if (json.has(`${ws.name}\u0000${c}`)) {
          try {
            r[c] = JSON.parse(v);
          } catch {
            throw new Error(`Sheet "${ws.name}", row ${i + 2}, column "${c}": the JSON text was changed and can no longer be read.`);
          }
        }
      }
      if (r._id !== undefined) r._id = String(r._id);
      return r;
    });
  }

  const byId = new Map();
  const filesWs = wb.getWorksheet(FILES);
  if (filesWs) {
    for (const r of sheetRows(filesWs)) {
      const id = String(r._id);
      if (!byId.has(id)) byId.set(id, { _id: id, filename: String(r.filename ?? ''), metadata: r.metadata ? JSON.parse(r.metadata) : undefined, uploadDate: r.uploadDate, parts: [] });
      byId.get(id).parts[Number(r.part) - 1] = String(r.data ?? '');
    }
  }
  const files = [...byId.values()].map(({ parts, ...f }) => ({ ...f, data: parts.join('') }));

  return { format: FORMAT, version: Number(infoMap.Version), createdAt: infoMap['Created At'], createdBy: infoMap['Created By'], data, ...(filesWs && { files }) };
}
