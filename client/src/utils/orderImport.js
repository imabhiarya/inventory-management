// Read purchase orders from GeM / other Excel (.xlsx), CSV or Word (.docx) files, and export orders to
// Excel in the same column layout (so an exported file can be edited and imported back).
// Rows / documents are matched to order fields by their headings or labels; rows that share a
// Supply Order / Contract No. (or GeM Order ID) become one order with several item lines.

import { cellText, parseCsv, excelRows } from './fileTable.js';

/** Order field → headings / labels that mean it (compared lower-case, letters and digits only). */
const ALIASES = {
  supplyOrderNo: ['supplyordercontractno', 'supplyorderno', 'contractno', 'contractnumber', 'gemcontractno', 'gemcontractnumber', 'contractid', 'sono', 'orderno', 'ordernumber', 'pono', 'purchaseorderno'],
  gemOrderId: ['gemorderid', 'orderid', 'gemid'],
  mode: ['mode', 'modeofprocurement', 'procurementmode'],
  orderDate: ['orderdate', 'contractdate', 'generateddate', 'contractgenerateddate', 'dateofcontract', 'podate', 'date'],
  vendor: ['firmvendor', 'vendor', 'vendorname', 'seller', 'sellername', 'firm', 'firmname', 'supplier', 'suppliername', 'companyname', 'sellercompanyname'],
  vendorGstin: ['vendorgstin', 'gstin', 'sellergstin', 'gstno', 'gstinno'],
  demandNo: ['demandno', 'demandnumber', 'indentno'],
  demandDate: ['demanddate', 'indentdate'],
  demandFrom: ['demandfrom', 'demandingunit', 'buyerdepartment', 'department', 'section'],
  approvalDate: ['approvaldate', 'cfaapprovaldate', 'sanctiondate'],
  approvedBy: ['approvedby', 'cfa', 'approvingauthority'],
  notingNo: ['notingno', 'notingnumber', 'noteno'],
  notingDate: ['notingdate', 'notedate'],
  codeHead: ['codehead', 'head', 'budgethead'],
  budgetYear: ['fy', 'financialyear', 'budgetyear', 'budgetfinancialyear'],
  description: ['itemdescription', 'description', 'item', 'itemname', 'product', 'productname', 'productdescription', 'category', 'itemsordered'],
  qty: ['qty', 'quantity', 'orderedquantity', 'orderedqty'],
  uom: ['uom', 'unit', 'unitofmeasure', 'unitofmeasurement'],
  rate: ['rate', 'unitprice', 'unitpriceinr', 'price', 'rateinr', 'rates'],
  amount: ['amount', 'amountinr', 'total', 'totalprice', 'totalvalue', 'totalvalueinr', 'value', 'ordervalue', 'totalorderamount', 'totalorderamountinr', 'ordervaluers'],
  expectedDelivery: ['expecteddelivery', 'deliverydate', 'deliveryby', 'lastdateofdelivery', 'deliveryperiod'],
  deliveredOn: ['deliveredon', 'dateofdelivery', 'receivedon'],
  receiptRef: ['crvreceiptref', 'crvno', 'receiptref', 'crv'],
  billNo: ['billno', 'billnumber', 'invoiceno', 'invoicenumber'],
  billDate: ['billdate', 'invoicedate'],
  billAmount: ['billamount', 'invoiceamount', 'invoicevalue'],
  billForwardedOn: ['forwardedtoaccountson', 'billforwardedon', 'forwardedon', 'forwardeddate'],
  accountsOffice: ['accountsoffice', 'accountoffice', 'cda', 'pao'],
  forwardingLetterNo: ['forwardingletterno', 'letterno', 'forwardingletter'],
  paymentDate: ['paymentdate', 'dateofpayment', 'paidon'],
  paymentAmount: ['amountpaid', 'paymentamount', 'paidamount'],
  paymentRef: ['dvchequeepaymentno', 'dvno', 'paymentref', 'chequeno', 'utrno', 'epaymentno'],
  remarks: ['remarks', 'remark', 'notes'],
};
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const FIELD_OF = new Map(Object.entries(ALIASES).flatMap(([field, names]) => names.map((n) => [n, field])));
const fieldFor = (heading) => FIELD_OF.get(norm(heading));
const LINE_FIELDS = ['description', 'qty', 'uom', 'rate', 'amount'];
const DATE_KEYS = ['orderDate', 'demandDate', 'approvalDate', 'notingDate', 'expectedDelivery', 'deliveredOn', 'billDate', 'billForwardedOn', 'paymentDate'];
const MONEY_KEYS = ['billAmount', 'paymentAmount'];
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** Any common date form (Excel date, 05-Nov-2026, 05/11/2026, 2026-11-05) → "2026-11-05", else ''. */
export function toIsoDate(v) {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[-/. ]([A-Za-z]{3})[A-Za-z]*[-/. ,]+(\d{2,4})/);
  if (m && MONTHS[m[2].toLowerCase()]) return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${String(MONTHS[m[2].toLowerCase()]).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/); // Indian order: day / month / year
  if (m) return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return '';
}
const toNumber = (v) => {
  const n = Number(String(v ?? '').replace(/[₹,\s]|INR|Rs\.?/gi, ''));
  return Number.isFinite(n) ? n : 0;
};

/** Turn field/value records (one per row or per document) into orders, merging rows of the same order. */
function recordsToOrders(records) {
  const byKey = new Map();
  const orders = [];
  for (const r of records) {
    const key = norm(r.supplyOrderNo || r.gemOrderId);
    let o = key && byKey.get(key);
    if (!o) {
      o = { lines: [] };
      orders.push(o);
      if (key) byKey.set(key, o);
    }
    for (const [k, v] of Object.entries(r)) {
      if (LINE_FIELDS.includes(k) || v === '' || v == null) continue;
      if (DATE_KEYS.includes(k)) {
        const d = toIsoDate(v);
        if (d && !o[k]) o[k] = d;
      } else if (MONEY_KEYS.includes(k)) {
        if (!o[k]) o[k] = toNumber(v);
      } else if (!o[k]) o[k] = String(v instanceof Date ? toIsoDate(v) : v).trim();
    }
    if (r.description) {
      const qty = toNumber(r.qty);
      const amount = toNumber(r.amount);
      const rate = toNumber(r.rate) || (qty && amount ? Math.round((amount / qty) * 100) / 100 : 0);
      o.lines.push({ description: String(r.description).trim(), qty, uom: String(r.uom || '').trim(), rate });
    } else if (r.amount && !o.orderValue) {
      o.orderValue = toNumber(r.amount); // a total without item lines
    }
  }
  return orders;
}

/** Rows (arrays of cell values) → records, using the first row (within the top 15) that looks like headings. */
function rowsToRecords(rows) {
  const headerIdx = rows.slice(0, 15).findIndex((row) => row.filter((c) => fieldFor(c)).length >= 2);
  if (headerIdx < 0) throw new Error('No column headings found (e.g. Contract No, Order Date, Seller, Item, Qty, Unit Price).');
  const fields = rows[headerIdx].map((h) => fieldFor(h));
  return rows
    .slice(headerIdx + 1)
    .map((row) => Object.fromEntries(fields.map((f, i) => [f, cellText(row[i])]).filter(([f, v]) => f && v !== '' && v != null)))
    .filter((r) => Object.keys(r).length);
}

async function readExcel(buffer) {
  return rowsToRecords((await excelRows(buffer))[0]);
}

function readCsv(text) {
  return rowsToRecords(parseCsv(text));
}

/**
 * Word (.docx): "Label : value" lines anywhere in the document (e.g. "Contract No: GEMC-…",
 * "Generated Date: 05-Nov-2026", "Company Name: …"), plus any table whose headings are item columns.
 */
async function readDocx(buffer) {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file('word/document.xml')?.async('string');
  if (!xml) throw new Error('This does not look like a Word (.docx) document.');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const textOf = (el) => [...el.getElementsByTagNameNS(W, 't')].map((t) => t.textContent).join('');
  const record = {};
  const lines = [];
  // Tables: a heading row with item columns gives item lines; 2-column tables are label / value pairs.
  for (const tbl of [...doc.getElementsByTagNameNS(W, 'tbl')]) {
    const rows = [...tbl.getElementsByTagNameNS(W, 'tr')].map((tr) => [...tr.getElementsByTagNameNS(W, 'tc')].map(textOf));
    const head = rows.findIndex((r) => r.filter((c) => LINE_FIELDS.includes(fieldFor(c))).length >= 2);
    if (head >= 0) {
      const fields = rows[head].map(fieldFor);
      for (const r of rows.slice(head + 1)) {
        const rec = Object.fromEntries(fields.map((f, i) => [f, r[i]]).filter(([f, v]) => f && v?.trim()));
        if (rec.description && !/^total/i.test(rec.description)) lines.push(rec);
      }
    } else {
      for (const r of rows) for (let i = 0; i + 1 < r.length; i += 2) {
        const f = fieldFor(r[i]);
        if (f && !LINE_FIELDS.includes(f) && r[i + 1]?.trim() && !record[f]) record[f] = r[i + 1].trim();
      }
    }
  }
  // Paragraphs: "Label : value".
  for (const p of [...doc.getElementsByTagNameNS(W, 'p')]) {
    const m = textOf(p).match(/^\s*([^:]{2,60}?)\s*[:：-]\s*(.+)$/);
    const f = m && fieldFor(m[1]);
    if (f && !record[f]) record[f] = m[2].trim();
  }
  if (!lines.length) return [record];
  return lines.map((l) => ({ ...record, ...l }));
}

/** Read one file → { orders, file } (orders not yet saved). */
export async function readOrderFile(file) {
  const name = file.name.toLowerCase();
  let records;
  if (name.endsWith('.xlsx')) records = await readExcel(await file.arrayBuffer());
  else if (name.endsWith('.csv')) records = readCsv(await file.text());
  else if (name.endsWith('.docx')) records = await readDocx(await file.arrayBuffer());
  else if (name.endsWith('.xls') || name.endsWith('.doc')) throw new Error(`"${file.name}": old Office format. Open it and "Save As" .xlsx / .docx, then import.`);
  else throw new Error(`"${file.name}": only Excel (.xlsx), CSV or Word (.docx) files can be imported.`);
  return recordsToOrders(records);
}

/** Columns of the import template / export (one row per item line; order details repeated). */
export const ORDER_COLUMNS = [
  ['supplyOrderNo', 'Supply Order / Contract No'], ['mode', 'Mode of Procurement'], ['budgetYear', 'Financial Year'],
  ['orderDate', 'Order Date'], ['vendor', 'Firm / Vendor'], ['demandNo', 'Demand No'], ['demandDate', 'Demand Date'],
  ['demandFrom', 'Demand From'], ['approvalDate', 'Approval Date'], ['approvedBy', 'Approved By'], ['notingNo', 'Noting No'], ['notingDate', 'Noting Date'],
  ['codeHead', 'Code Head'], ['description', 'Item Description'], ['qty', 'Qty'], ['uom', 'UoM'], ['rate', 'Unit Price'], ['amount', 'Amount'],
  ['expectedDelivery', 'Expected Delivery'], ['deliveredOn', 'Delivered On'], ['receiptRef', 'CRV / Receipt Ref'], ['billNo', 'Bill No'], ['billDate', 'Bill Date'],
  ['billAmount', 'Bill Amount'], ['billForwardedOn', 'Forwarded to Accounts On'], ['accountsOffice', 'Accounts Office'], ['forwardingLetterNo', 'Forwarding Letter No'],
  ['paymentDate', 'Payment Date'], ['paymentAmount', 'Amount Paid'], ['paymentRef', 'DV / Cheque / e-Payment No'], ['remarks', 'Remarks'],
];

/** Download orders (or an empty template) as Excel in the import layout. */
export async function downloadOrdersExcel(orders, filename) {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Orders');
  ws.columns = ORDER_COLUMNS.map(([key, header]) => ({ header, key, width: Math.max(12, header.length + 2) }));
  ws.getRow(1).font = { bold: true };
  const iso = (d) => (d ? String(d).slice(0, 10) : '');
  for (const o of orders) {
    const base = Object.fromEntries(ORDER_COLUMNS.map(([k]) => [k, DATE_KEYS.includes(k) ? iso(o[k]) : o[k] ?? '']));
    const lines = o.lines?.length ? o.lines : [{ description: '', qty: '', uom: '', rate: '', amount: o.orderValue || '' }];
    for (const l of lines) ws.addRow({ ...base, description: l.description, qty: l.qty, uom: l.uom, rate: l.rate, amount: l.amount ?? (l.qty && l.rate ? l.qty * l.rate : '') });
  }
  const buf = await wb.xlsx.writeBuffer();
  const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
