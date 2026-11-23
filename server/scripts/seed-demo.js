// Load demo items and transactions (matching the prototype screens) into an EMPTY database.
// Usage: npm run seed:demo           (refuses if items already exist)
import env from '../src/config/env.js';
import { connectDb, disconnectDb } from '../src/db.js';
import Item from '../src/models/Item.js';
import User from '../src/models/User.js';
import { getSettings } from '../src/models/misc.js';
import { createApp } from '../src/app.js';
import { issueSession } from '../src/middleware/auth.js';

const ITEMS = [
  { name: 'A4 Paper (75 GSM)', description: 'A4 Size, 75 GSM, 500 Sheets', ledger: 'STATIONARY', uom: 'Ream', minStock: 50, openingQty: 100, openingRate: 280 },
  { name: 'Ball Pen (Blue)', description: 'Ball Pen, Blue Ink', ledger: 'STATIONARY', uom: 'Nos', minStock: 100, openingQty: 400, openingRate: 10 },
  { name: 'Office Table (Steel)', description: 'Steel office table 4x2 ft', ledger: 'STATIONARY', uom: 'Nos', minStock: 2 },
  { name: 'Office Chair (Revolving)', description: 'Revolving chair with arms', ledger: 'STATIONARY', uom: 'Nos', minStock: 2 },
  { name: 'File Rack (Steel)', description: '5 shelf steel rack', ledger: 'STATIONARY', uom: 'Nos', minStock: 1 },
  { name: 'Spanner Set', description: 'Spanner Set (6–24 mm)', ledger: 'TP', uom: 'Set', minStock: 2, openingQty: 6, openingRate: 1450 },
  { name: 'Desktop Computer', description: 'i5, 16GB RAM, 512GB SSD', ledger: 'IT', uom: 'Nos', minStock: 5, openingQty: 8, openingRate: 52000 },
  { name: 'Scrap Steel', description: 'MS Scrap (Survey Off)', ledger: 'SALVAGE', uom: 'Kg', minStock: 0, openingQty: 350, openingRate: 30 },
  { name: 'Portable Drill Machine', description: '13 mm, 650 W', ledger: 'LOAN', uom: 'Nos', minStock: 1, openingQty: 3, openingRate: 4200 },
  { name: 'Projector', description: 'Full HD projector', ledger: 'LOAN', uom: 'Nos', minStock: 1, openingQty: 2, openingRate: 38000 },
  { name: 'Laptop', description: 'i5 laptop for presentations', ledger: 'LOAN', uom: 'Nos', minStock: 1, openingQty: 4, openingRate: 61000 },
  { name: 'Extension Board (Multi Plug)', description: '6 socket with surge protection', ledger: 'LOAN', uom: 'Nos', minStock: 2, openingQty: 6, openingRate: 650 },
];

async function main() {
  await connectDb(env.MONGODB_URI);
  if (await Item.estimatedDocumentCount()) throw new Error('Items already exist; demo data is only loaded into an empty database.');
  const admin = await User.findOne({ role: 'admin', active: true });
  if (!admin) throw new Error('Create an admin first: npm run create-admin');
  await getSettings();

  // Go through the real API so every business rule is applied.
  const app = createApp();
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  let cookie = '';
  issueSession({ cookie: (name, value) => (cookie = `${name}=${value}`) }, admin);

  const call = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
    const json = await r.json();
    if (!r.ok) throw new Error(`${method} ${url}: ${json.error}`);
    return json;
  };

  const ids = {};
  for (const it of ITEMS) {
    const { openingQty, openingRate, ...fields } = it;
    const { item } = await call('POST', '/items', fields);
    ids[it.name] = item._id;
  }
  // Opening stock is brought in as a receipt at the start of the financial year.
  // One opening receipt per Type of Store / Ledger (a voucher holds items of a single ledger).
  for (const ledger of [...new Set(ITEMS.filter((it) => it.openingQty).map((it) => it.ledger))]) {
    const lines = ITEMS.filter((it) => it.openingQty && it.ledger === ledger).map((it) => ({ item: ids[it.name], qty: it.openingQty, rate: it.openingRate, ledgerPageNo: '1' }));
    await call('POST', '/receipts', { date: '2025-04-01', receiptType: 'Transfer', ledger, source: 'MES Store Subsidiary', poNo: 'OPENING/2025-26', poDate: '2025-04-01', remarks: 'Opening stock', lines });
  }
  const a4 = ids['A4 Paper (75 GSM)'];
  await call('POST', '/receipts', { date: '2025-04-05', receiptType: 'Purchase', ledger: 'STATIONARY', source: 'Supplier / Firm', poNo: 'PO/25-26/0045', poDate: '2025-04-02', lines: [{ item: a4, qty: 200, rate: 285, ledgerPageNo: '12' }] });
  await call('POST', '/issues', { date: '2025-04-10', issueType: 'Issue', ledger: 'STATIONARY', issueTo: 'Admin Section', authorityRef: 'IA/2025-26/0011', lines: [{ item: a4, qty: 50, ledgerPageNo: '12', remarks: 'Issued to Admin Section' }] });
  await call('POST', '/issues', { date: '2025-04-18', issueType: 'Issue', ledger: 'STATIONARY', issueTo: 'Admin Section', authorityRef: 'IA/2025-26/0019', lines: [{ item: a4, qty: 25, ledgerPageNo: '12', remarks: 'Issued to Office' }] });
  await call('POST', '/receipts', { date: '2025-04-25', receiptType: 'Purchase', ledger: 'STATIONARY', source: 'Supplier / Firm', poNo: 'PO/25-26/0081', poDate: '2025-04-21', lines: [{ item: a4, qty: 100, rate: 290, ledgerPageNo: '12' }] });
  await call('POST', '/issues', { date: '2025-04-30', issueType: 'Issue', ledger: 'STATIONARY', issueTo: 'Conference Section', authorityRef: 'IA/2025-26/0027', lines: [{ item: a4, qty: 75, ledgerPageNo: '12', remarks: 'Issued to Conference Room' }] });
  await call('POST', '/receipts', {
    date: '2026-01-14', receiptType: 'Purchase', ledger: 'STATIONARY', source: 'HQ CWE Shillong', poNo: 'PO/2025-26/0187', poDate: '2026-01-08',
    lines: [
      { item: ids['Office Table (Steel)'], qty: 10, rate: 4500, codeHead: '2210', ledgerPageNo: '31' },
      { item: ids['Office Chair (Revolving)'], qty: 15, rate: 2800, codeHead: '2210', ledgerPageNo: '32' },
      { item: ids['File Rack (Steel)'], qty: 5, rate: 7500, codeHead: '2210', ledgerPageNo: '33' },
    ],
  });
  await call('POST', '/issues', {
    date: '2026-01-18', issueType: 'Issue', ledger: 'STATIONARY', issueTo: 'HQ CWE Shillong / Admin Section', authorityRef: 'IA/2025-26/0145',
    lines: [
      { item: ids['Office Chair (Revolving)'], qty: 10, ledgerPageNo: '32', remarks: 'For Admin Section' },
      { item: ids['Office Table (Steel)'], qty: 5, ledgerPageNo: '31', remarks: 'For Meeting Room' },
      { item: ids['File Rack (Steel)'], qty: 2, ledgerPageNo: '33', remarks: 'For Record Room' },
    ],
  });
  const { voucher } = await call('POST', '/loans/issue', {
    date: '2026-01-05', issueTo: 'Conference Section', loanType: 'Loan Issue', reference: 'IA/2025-26/0130', returnDueDate: '2026-02-05', remarks: 'For Meeting',
    lines: [{ item: ids['Projector'], qty: 1 }, { item: ids['Laptop'], qty: 2 }, { item: ids['Extension Board (Multi Plug)'], qty: 2 }],
  });
  await call('POST', '/loans/receipt', { date: '2026-01-10', againstIssue: voucher._id, remarks: 'Returned (Good Condition)', lines: [{ item: ids['Laptop'], qty: 2 }] });

  server.close();
  console.log(`Loaded ${ITEMS.length} demo items with receipts, issues and loans.`);
  await disconnectDb();
}

main().then(
  // Exit explicitly: open handles (timers, the IPC channel of an Electron utility
  // process) can otherwise keep the process alive after the work is done.
  () => process.exit(process.exitCode ?? 0),
  async (err) => {
    console.error(`Error: ${err.message}`);
    await disconnectDb().catch(() => {});
    process.exit(1);
  },
);
