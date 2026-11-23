import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { createApp } from '../src/app.js';
import { startDb, stopDb, resetDb, makeUser } from './helpers.js';
import Item from '../src/models/Item.js';

beforeAll(startDb);
afterAll(stopDb);
beforeEach(resetDb);

const receipt = (lines, extra = {}) => ({
  date: '2025-05-01',
  receiptType: 'Purchase',
  ledger: 'STATIONARY',
  source: 'Supplier / Firm',
  poNo: 'PO/1',
  poDate: '2025-04-01',
  lines,
  ...extra,
});
const issue = (lines, extra = {}) => ({
  date: '2025-05-10',
  issueType: 'Issue',
  ledger: 'STATIONARY',
  issueTo: 'Admin Section',
  authorityRef: 'IA/1',
  lines,
  ...extra,
});

/** Register an item; `openingQty` (test helper only) brings stock in via a receipt dated 2025-04-01. */
async function newItem(agent, { openingQty, openingRate = 0, openingDate = '2025-04-01', ...body } = {}) {
  const res = await agent
    .post('/api/items')
    .send({ name: 'A4 Paper', ledger: 'STATIONARY', uom: 'Ream', minStock: 50, ...body });
  expect(res.status).toBe(201);
  if (!openingQty) return res.body.item;
  const r = await agent
    .post('/api/receipts')
    .send(receipt([{ item: res.body.item._id, qty: openingQty, rate: openingRate }], { date: openingDate, poNo: 'OPENING', ledger: res.body.item.ledger }));
  expect(r.status).toBe(201);
  return (await agent.get(`/api/items/${res.body.item._id}`)).body.item;
}

describe('auth', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await request(createApp()).get('/api/items');
    expect(res.status).toBe(401);
  });

  it('rejects wrong password without revealing whether the user exists', async () => {
    await makeUser('admin', 'boss');
    const app = createApp();
    const a = await request(app).post('/api/auth/login').send({ username: 'boss', password: 'wrong' });
    const b = await request(app).post('/api/auth/login').send({ username: 'nobody', password: 'wrong' });
    expect(a.status).toBe(401);
    expect(a.body.error).toBe(b.body.error);
  });

  it('sets an httpOnly cookie and returns the user on /me', async () => {
    const agent = await makeUser('admin', 'boss');
    const me = await agent.get('/api/auth/me');
    expect(me.body.user.username).toBe('boss');
    expect(me.body.user.passwordHash).toBeUndefined();
  });

  it('invalidates other sessions after a password change', async () => {
    const agent = await makeUser('admin', 'boss');
    const other = request.agent(createApp());
    await other.post('/api/auth/login').send({ username: 'boss', password: 'Passw0rd!' });
    const res = await agent.post('/api/auth/change-password').send({ currentPassword: 'Passw0rd!', newPassword: 'NewPassw0rd' });
    expect(res.status).toBe(200);
    expect((await agent.get('/api/auth/me')).status).toBe(200);
    expect((await other.get('/api/auth/me')).status).toBe(401);
  });

  it('enforces roles: viewer cannot create, storekeeper cannot manage users', async () => {
    const viewer = await makeUser('viewer', 'viewer1');
    expect((await viewer.post('/api/items').send({ name: 'X', ledger: 'IT', uom: 'Nos' })).status).toBe(403);
    const sk = await makeUser('storekeeper', 'sk1');
    expect((await sk.get('/api/users')).status).toBe(403);
    expect((await sk.get('/api/backup')).status).toBe(403);
  });

  it('rejects non-JSON state-changing requests (CSRF guard)', async () => {
    const agent = await makeUser();
    const res = await agent.post('/api/items').type('form').send('name=x&ledger=IT&uom=Nos');
    expect(res.status).toBe(415);
  });
});

describe('items', () => {
  it('auto-generates codes per ledger; new items start at zero stock', async () => {
    const agent = await makeUser();
    const a = await newItem(agent, { openingQty: 100, openingRate: 250 });
    const b = await newItem(agent, { name: 'Pen' });
    const c = await newItem(agent, { name: 'PC', ledger: 'IT', uom: 'Nos' });
    expect([a.code, b.code, c.code]).toEqual(['ST-0001', 'ST-0002', 'IT-0001']);
    expect(a.currentStock).toBe(100); // via the helper's opening receipt
    expect(b.currentStock).toBe(0);
    const ignored = await agent.post('/api/items').send({ name: 'Ink', ledger: 'STATIONARY', uom: 'Nos', openingQty: 99, codeHead: '2210' });
    expect(ignored.body.item.currentStock).toBe(0);
    expect(ignored.body.item.codeHead).toBeUndefined();
  });

  it('refuses to delete an item with transactions', async () => {
    const agent = await makeUser();
    const it = await newItem(agent);
    await agent.post('/api/receipts').send(receipt([{ item: it._id, qty: 5, rate: 10 }]));
    expect((await agent.delete(`/api/items/${it._id}`)).status).toBe(409);
  });
});

describe('receipts and issues', () => {
  it('updates stock and weighted average rate, and values issues at that rate', async () => {
    const agent = await makeUser();
    const it = await newItem(agent, { openingQty: 100, openingRate: 200 });
    const r = await agent.post('/api/receipts').send(receipt([{ item: it._id, qty: 100, rate: 300 }]));
    expect(r.status).toBe(201);
    expect(r.body.receipt.receiptNo).toBe('R-000002'); // R-000001 is the opening receipt
    expect(r.body.receipt.totalAmount).toBe(30000);
    let doc = await Item.findById(it._id);
    expect(doc.currentStock).toBe(200);
    expect(doc.avgRate).toBe(250);

    const i = await agent.post('/api/issues').send(issue([{ item: it._id, qty: 40, ledgerPageNo: '12' }]));
    expect(i.status).toBe(201);
    expect(i.body.issue.totalAmount).toBe(10000);
    doc = await Item.findById(it._id);
    expect(doc.currentStock).toBe(160);
  });

  it('rejects issuing more than available, leaving stock untouched (atomic)', async () => {
    const agent = await makeUser();
    const a = await newItem(agent, { openingQty: 10 });
    const b = await newItem(agent, { name: 'Pen', openingQty: 1 });
    const res = await agent.post('/api/issues').send(
      issue([
        { item: a._id, qty: 5, ledgerPageNo: '1' },
        { item: b._id, qty: 2, ledgerPageNo: '2' },
      ]),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Insufficient stock for Pen/);
    expect((await Item.findById(a._id)).currentStock).toBe(10);
    expect((await agent.get('/api/issues')).body.total).toBe(0);
  });

  it('cancelling a receipt reverses stock, but not if the goods were already issued', async () => {
    const agent = await makeUser();
    const it = await newItem(agent);
    const r = (await agent.post('/api/receipts').send(receipt([{ item: it._id, qty: 10, rate: 5 }]))).body.receipt;
    await agent.post('/api/issues').send(issue([{ item: it._id, qty: 8, ledgerPageNo: '1' }]));
    const blocked = await agent.post(`/api/receipts/${r._id}/cancel`).send({ reason: 'wrong entry' });
    expect(blocked.status).toBe(400);

    const r2 = (await agent.post('/api/receipts').send(receipt([{ item: it._id, qty: 4, rate: 5 }]))).body.receipt;
    const ok = await agent.post(`/api/receipts/${r2._id}/cancel`).send({ reason: 'duplicate' });
    expect(ok.status).toBe(200);
    expect(ok.body.receipt.status).toBe('CANCELLED');
    expect((await Item.findById(it._id)).currentStock).toBe(2);
  });

  it('editing an issue re-applies quantities', async () => {
    const agent = await makeUser();
    const it = await newItem(agent, { openingQty: 20 });
    const i = (await agent.post('/api/issues').send(issue([{ item: it._id, qty: 5, ledgerPageNo: '1' }]))).body.issue;
    const res = await agent.put(`/api/issues/${i._id}`).send(issue([{ item: it._id, qty: 12, ledgerPageNo: '1' }]));
    expect(res.status).toBe(200);
    expect((await Item.findById(it._id)).currentStock).toBe(8);
  });
});

describe('type of store / ledger on vouchers', () => {
  it('only accepts items from the voucher ledger and filters registers by ledger', async () => {
    const agent = await makeUser();
    const paper = await newItem(agent, { openingQty: 5 });
    const pc = await newItem(agent, { name: 'PC', ledger: 'IT', uom: 'Nos' });
    const bad = await agent.post('/api/receipts').send(receipt([{ item: pc._id, qty: 1, rate: 1 }]));
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/PC \(IT-0001\) is not in the Stationary Ledger/);
    expect((await agent.post('/api/issues').send(issue([{ item: paper._id, qty: 1, ledgerPageNo: '1' }], { ledger: 'IT' }))).status).toBe(400);
    expect((await agent.post('/api/receipts').send(receipt([{ item: pc._id, qty: 1, rate: 1 }], { ledger: 'NOPE' }))).status).toBe(400);
    await agent.post('/api/receipts').send(receipt([{ item: pc._id, qty: 2, rate: 1 }], { ledger: 'IT' }));
    const it = (await agent.get('/api/receipts').query({ ledger: 'IT' })).body;
    expect(it.total).toBe(1);
    expect(it.rows[0].ledger).toBe('IT');
  });

  it('migrates old vouchers that stored a free-text store name', async () => {
    const { Receipt } = await import('../src/models/Voucher.js');
    const { migrateVoucherLedgers } = await import('../src/migrations.js');
    const agent = await makeUser();
    const pc = await newItem(agent, { name: 'PC', ledger: 'IT', uom: 'Nos', openingQty: 3 });
    const r = await Receipt.findOne();
    await Receipt.collection.updateOne({ _id: r._id }, { $unset: { ledger: '' }, $set: { store: 'MES General Store' } });
    expect(await migrateVoucherLedgers()).toBe(1);
    const raw = await Receipt.collection.findOne({ _id: r._id });
    expect(raw.ledger).toBe('IT');
    expect(raw.store).toBeUndefined();
    expect(pc.code).toBe('IT-0001');
  });
});

describe('PO / sanction date', () => {
  it('is required, saved, and cannot be after the receipt date', async () => {
    const agent = await makeUser();
    const it = await newItem(agent);
    const line = [{ item: it._id, qty: 1, rate: 1 }];
    const { poDate, ...noDate } = receipt(line);
    expect(poDate).toBe('2025-04-01');
    expect((await agent.post('/api/receipts').send(noDate)).status).toBe(400);
    const late = await agent.post('/api/receipts').send(receipt(line, { date: '2025-05-01', poDate: '2025-05-02' }));
    expect(late.status).toBe(400);
    expect(late.body.error).toMatch(/cannot be after the receipt date/);
    const ok = await agent.post('/api/receipts').send(receipt(line, { date: '2025-05-01', poDate: '2025-04-20' }));
    expect(ok.status).toBe(201);
    expect(ok.body.receipt.poDate.slice(0, 10)).toBe('2025-04-20');
  });
});

describe('Old RV No.', () => {
  it('is optional, saved on the receipt, searchable, and carried to the master ledger (also after edit)', async () => {
    const agent = await makeUser();
    const it = await newItem(agent);
    const line = [{ item: it._id, qty: 2, rate: 5 }];
    const plain = await agent.post('/api/receipts').send(receipt(line));
    expect(plain.status).toBe(201);
    expect(plain.body.receipt.oldRvNo).toBe('');
    const r = (await agent.post('/api/receipts').send(receipt(line, { oldRvNo: 'RV/2019/77' }))).body.receipt;
    expect(r.oldRvNo).toBe('RV/2019/77');

    const found = await agent.get('/api/receipts').query({ q: 'RV/2019' });
    expect(found.body.rows.map((x) => x.receiptNo)).toEqual([r.receiptNo]);

    const ledgerRows = async () =>
      (await agent.get('/api/ledger').query({ ledger: 'STATIONARY', item: it._id, from: '2025-04-01', to: '2025-05-31' })).body.rows;
    expect((await ledgerRows()).map((x) => x.oldRvNo)).toEqual(['', 'RV/2019/77']);

    expect((await agent.put(`/api/receipts/${r._id}`).send(receipt(line, { oldRvNo: 'RV/2020/01' }))).status).toBe(200);
    expect((await ledgerRows()).map((x) => x.oldRvNo)).toEqual(['', 'RV/2020/01']);
  });
});

describe('B/F receipts', () => {
  it('need no PO / sanction, keep an Old Ledger Page instead of an Old RV No., and show it in the ledger remarks', async () => {
    const agent = await makeUser();
    const it = await newItem(agent);
    const line = [{ item: it._id, qty: 3, rate: 5, ledgerPageNo: '14' }];
    const res = await agent
      .post('/api/receipts')
      .send(receipt(line, { receiptType: 'B/F', source: 'Old Ledger', poNo: '', poDate: undefined, oldRvNo: 'X', oldLedgerPage: '27' }));
    expect(res.status).toBe(201);
    expect(res.body.receipt).toMatchObject({ receiptType: 'B/F', oldLedgerPage: '27', oldRvNo: '', poNo: '' });
    expect(res.body.receipt.poDate).toBeUndefined();

    const rows = (await agent.get('/api/ledger').query({ ledger: 'STATIONARY', item: it._id, from: '2025-04-01', to: '2025-05-31' })).body.rows;
    // The Old Ledger Page is shown in its own field; Remarks carry only what the user typed (none here).
    expect(rows.at(-1)).toMatchObject({ oldLedgerPage: '27', remarks: '' });

    // Any other receipt type still needs the PO, and drops an Old Ledger Page.
    expect((await agent.post('/api/receipts').send(receipt(line, { poNo: '' }))).status).toBe(400);
    const plain = await agent.post('/api/receipts').send(receipt(line, { oldLedgerPage: '27' }));
    expect(plain.body.receipt.oldLedgerPage).toBe('');
  });
});

describe('BER / SVY OFF report', () => {
  it('leaves out Loan Store and Salvage ledger items', async () => {
    const agent = await makeUser();
    const st = await newItem(agent, { openingQty: 2 });
    const sv = await newItem(agent, { name: 'Scrap', ledger: 'SALVAGE', openingQty: 2 });
    const ln = await newItem(agent, { name: 'Tent', ledger: 'LOAN' });
    expect([st.ledger, sv.ledger, ln.ledger]).toEqual(['STATIONARY', 'SALVAGE', 'LOAN']);
    const codes = async (q) => (await agent.get('/api/reports/item-life').query({ asOn: '2026-01-01', ...q })).body.rows.map((r) => r.item.code);
    expect(await codes({})).toEqual([st.code]);
    expect(await codes({ ledger: 'SALVAGE' })).toEqual([]);
    expect(await codes({ ledger: 'LOAN' })).toEqual([]);
  });
});

describe('Old IV No.', () => {
  it('is optional, saved on the issue, searchable, and carried to the master ledger (also after edit)', async () => {
    const agent = await makeUser();
    const it = await newItem(agent);
    await agent.post('/api/receipts').send(receipt([{ item: it._id, qty: 10, rate: 5 }]));
    const line = [{ item: it._id, qty: 1, ledgerPageNo: '4' }];
    const plain = await agent.post('/api/issues').send(issue(line));
    expect(plain.status).toBe(201);
    expect(plain.body.issue.oldIvNo).toBe('');
    const i = (await agent.post('/api/issues').send(issue(line, { oldIvNo: 'IV/2019/12' }))).body.issue;
    expect(i.oldIvNo).toBe('IV/2019/12');

    const found = await agent.get('/api/issues').query({ q: 'IV/2019' });
    expect(found.body.rows.map((x) => x.issueNo)).toEqual([i.issueNo]);

    const ivNos = async () =>
      (await agent.get('/api/ledger').query({ ledger: 'STATIONARY', item: it._id, from: '2025-04-01', to: '2025-05-31' })).body.rows
        .filter((x) => x.issueQty)
        .map((x) => x.oldIvNo);
    expect(await ivNos()).toEqual(['', 'IV/2019/12']);

    expect((await agent.put(`/api/issues/${i._id}`).send(issue(line, { oldIvNo: 'IV/2020/01' }))).status).toBe(200);
    expect(await ivNos()).toEqual(['', 'IV/2020/01']);
  });
});

describe('ledger page memory', () => {
  it('fills an empty Item Master ledger page from the first voucher line, but never overwrites one', async () => {
    const agent = await makeUser();
    const blank = await newItem(agent);
    const set = await newItem(agent, { name: 'Pen', ledgerPage: '9' });
    await agent.post('/api/receipts').send(receipt([
      { item: blank._id, qty: 5, rate: 1, ledgerPageNo: ' 14 ' },
      { item: set._id, qty: 5, rate: 1, ledgerPageNo: '99' },
    ]));
    const pages = async () => {
      const items = (await agent.get('/api/items')).body.items;
      return [blank, set].map((x) => items.find((y) => y._id === x._id).ledgerPage);
    };
    expect(await pages()).toEqual(['14', '9']);
    await agent.post('/api/issues').send(issue([{ item: blank._id, qty: 1, ledgerPageNo: '50' }]));
    expect(await pages()).toEqual(['14', '9']);
  });
});

describe('Issue Frequency and Certified Issue Voucher', () => {
  it('allows any item of the ledger on monthly issues and consolidates them per item for the month', async () => {
    const agent = await makeUser();
    const paper = await newItem(agent, { category: 'CONSUMABLE', openingQty: 100, openingRate: 10 });
    const table = await newItem(agent, { name: 'Table', openingQty: 5, openingRate: 1000 });
    expect(table.category).toBe('NON_CONSUMABLE');

    // Non-consumable items can be issued monthly too (here in June, so May's CIV is unaffected).
    const nonConsumable = await agent.post('/api/issues').send(issue([{ item: table._id, qty: 1, ledgerPageNo: '1' }], { frequency: 'MONTHLY', civMonth: '2025-06', date: '2025-06-02' }));
    expect(nonConsumable.status).toBe(201);

    const m1 = (await agent.post('/api/issues').send(issue([{ item: paper._id, qty: 3, ledgerPageNo: '12' }], { frequency: 'MONTHLY', civMonth: '2025-05', date: '2025-05-05' }))).body.issue;
    expect(m1.frequency).toBe('MONTHLY');
    await agent.post('/api/issues').send(issue([{ item: paper._id, qty: 2, ledgerPageNo: '12' }], { frequency: 'MONTHLY', civMonth: '2025-05', date: '2025-05-20', issueTo: 'Accounts' }));
    await agent.post('/api/issues').send(issue([{ item: paper._id, qty: 7, ledgerPageNo: '12' }], { date: '2025-05-21' })); // regular: excluded
    await agent.post('/api/issues').send(issue([{ item: paper._id, qty: 1, ledgerPageNo: '12' }], { frequency: 'MONTHLY', civMonth: '2025-06', date: '2025-06-01' })); // next month
    const regular = (await agent.post('/api/issues').send(issue([{ item: table._id, qty: 1, ledgerPageNo: '2' }]))).body.issue;
    expect(regular.frequency).toBe('REGULAR');

    const civ = (await agent.get('/api/reports/civ').query({ month: '2025-05', ledger: 'STATIONARY' })).body;
    expect(civ.rows).toHaveLength(1);
    expect(civ.rows[0]).toMatchObject({ qty: 5, amount: 50, rate: 10, ledgerPages: '12' });
    expect(civ.issues).toHaveLength(2);
    expect(civ.totalAmount).toBe(50);

    const unit = (await agent.get('/api/reports/civ').query({ month: '2025-05', issueTo: 'Accounts' })).body;
    expect(unit.rows[0].qty).toBe(2);

  });

  it('puts a monthly issue on the CIV of its chosen month, which is required and not after the issue date', async () => {
    const agent = await makeUser();
    const paper = await newItem(agent, { openingQty: 100, openingRate: 10 });
    const line = [{ item: paper._id, qty: 4, ledgerPageNo: '12' }];

    const missing = await agent.post('/api/issues').send(issue(line, { frequency: 'MONTHLY', date: '2025-06-03' }));
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/month/i);
    const future = await agent.post('/api/issues').send(issue(line, { frequency: 'MONTHLY', civMonth: '2025-07', date: '2025-06-03' }));
    expect(future.status).toBe(400);

    // Issued on 3 June for May's consumption.
    const i = (await agent.post('/api/issues').send(issue(line, { frequency: 'MONTHLY', civMonth: '2025-05', date: '2025-06-03' }))).body.issue;
    expect(i.civMonth).toBe('2025-05');
    const civ = async (month) => (await agent.get('/api/reports/civ').query({ month })).body.rows.map((r) => r.qty);
    expect(await civ('2025-05')).toEqual([4]);
    expect(await civ('2025-06')).toEqual([]);

    // Switching to Regular clears the month and takes it off the CIV.
    const reg = (await agent.put(`/api/issues/${i._id}`).send(issue(line, { frequency: 'REGULAR', civMonth: '2025-05', date: '2025-06-03' }))).body.issue;
    expect(reg.civMonth).toBe('');
    expect(await civ('2025-05')).toEqual([]);
  });
});

describe('master ledger', () => {
  it('computes running balance with brought-forward opening', async () => {
    const agent = await makeUser();
    const it = await newItem(agent, { openingQty: 100, openingDate: '2025-04-01' });
    await agent.post('/api/receipts').send(receipt([{ item: it._id, qty: 200, rate: 1 }], { date: '2025-04-05' }));
    await agent.post('/api/issues').send(issue([{ item: it._id, qty: 50, ledgerPageNo: '1' }], { date: '2025-04-10' }));
    // Back-dated receipt entered later must still slot in by date.
    await agent.post('/api/receipts').send(receipt([{ item: it._id, qty: 10, rate: 1 }], { date: '2025-04-07' }));

    const res = await agent.get('/api/ledger').query({ ledger: 'STATIONARY', item: it._id, from: '2025-04-06', to: '2025-04-30' });
    expect(res.status).toBe(200);
    expect(res.body.rows.map((r) => r.balance)).toEqual([300, 310, 260]);
    expect(res.body.summary).toMatchObject({ openingQty: 300, totalReceipt: 10, totalIssue: 50, closingQty: 260 });
  });
});

describe('Loan Store Ledger summary', () => {
  it('records the Type of Loan Store on Loan Store Ledger receipts / issues and filters the ledger by it', async () => {
    const agent = await makeUser();
    const almirah = await newItem(agent, { name: 'Almirah', ledger: 'LOAN', uom: 'Nos' });
    const vise = await newItem(agent, { name: 'Bench Vice', ledger: 'LOAN', uom: 'Nos' });
    const rec = (item, type) => receipt([{ item: item._id, qty: 3, rate: 0 }], { ledger: 'LOAN', poNo: '', loanStoreType: type });
    expect((await agent.post('/api/receipts').send(rec(almirah, ''))).status).toBe(400); // type required for Loan Store
    expect((await agent.post('/api/receipts').send(rec(almirah, 'Furniture Store'))).body.receipt.loanStoreType).toBe('Furniture Store');
    expect((await agent.post('/api/receipts').send(rec(vise, 'T&P Store'))).status).toBe(201);
    // Other ledgers never carry a loan store type.
    const pen = await newItem(agent, { name: 'Pen' });
    expect((await agent.post('/api/receipts').send(receipt([{ item: pen._id, qty: 1, rate: 1 }], { loanStoreType: 'Furniture Store' }))).body.receipt.loanStoreType).toBe('');

    const q = { from: '2025-04-01', to: '2026-03-31' };
    const all = (await agent.get('/api/loans/ledger').query(q)).body.rows;
    expect(all.find((r) => r.item._id === almirah._id).storeTypes).toEqual(['Furniture Store']);
    const furniture = (await agent.get('/api/loans/ledger').query({ ...q, storeType: 'Furniture Store' })).body.rows;
    expect(furniture.map((r) => r.item.name)).toEqual(['Almirah']);
    const one = (await agent.get('/api/loans/ledger').query({ ...q, item: vise._id })).body;
    expect(one.rows.find((r) => !r.opening).storeType).toBe('T&P Store');
  });

  it('lists items registered in the Loan Store Ledger even before any loan movement', async () => {
    const agent = await makeUser();
    const almirah = await newItem(agent, { name: 'Almirah Steel', ledger: 'LOAN', uom: 'Nos' });
    expect(almirah.code).toBe('LN-0001');
    const rows = (await agent.get('/api/loans/ledger').query({ from: '2026-04-01', to: '2027-03-31' })).body.rows;
    expect(rows.find((r) => r.item._id === almirah._id)).toMatchObject({ opening: 0, received: 0, issued: 0, closing: 0, withSections: 0 });
  });
});

describe('master ledger: optional dates and stock filter', () => {
  it('lists every item of the ledger item-wise, with dates optional and All / Bal Qty / 0 Holding filters', async () => {
    const agent = await makeUser();
    const pen = await newItem(agent, { name: 'Pen', openingQty: 10 }); // ST-0001, holds 10
    const ink = await newItem(agent, { name: 'Ink', description: 'Stamp pad ink, blue, 30 ml' }); // ST-0002, never used
    const pad = await newItem(agent, { name: 'Pad', openingQty: 4 }); // ST-0003, fully issued below
    const iss = await agent.post('/api/issues').send(issue([{ item: pad._id, qty: 4, ledgerPageNo: '3', remarks: 'For office use' }]));
    expect(iss.body.error).toBeUndefined();

    const get = async (q = {}) => (await agent.get('/api/ledger').query({ ledger: 'STATIONARY', ...q })).body;
    const all = await get(); // no dates at all
    expect(all.from).toBeNull();
    expect([...new Set(all.rows.map((r) => r.item.name))]).toEqual(['Pen', 'Ink', 'Pad']); // item-code order
    expect(all.rows.find((r) => r.item.name === 'Ink')).toMatchObject({ voucherType: 'Nil', balance: 0 });
    expect(all.rows.find((r) => r.item.name === 'Ink').item.description).toBe('Stamp pad ink, blue, 30 ml');
    const penReceipt = all.rows.find((r) => r.item.name === 'Pen' && r.voucherType === 'Receipt');
    expect(penReceipt).toMatchObject({ poNo: 'OPENING', source: 'Supplier / Firm' });
    expect(penReceipt.poDate).toBeTruthy();
    expect(all.rows.find((r) => r.item.name === 'Pad' && r.voucherType === 'Issue').issueTo).toBe('Admin Section');
    expect(all.rows.find((r) => r.item.name === 'Pad' && r.voucherType === 'Issue').remarks).toBe('For office use');
    // Remarks: blank unless typed on the voucher (auto text like "Purchase (PO/1)" is never shown).
    expect(penReceipt.remarks).toBe('');
    expect(all.rows.find((r) => r.item.name === 'Ink').remarks).toBe('');
    expect(all.rows.filter((r) => r.item.name === 'Pad').map((r) => r.balance)).toEqual([4, 0]);

    expect([...new Set((await get({ holding: 'HELD' })).rows.map((r) => r.item.name))]).toEqual(['Pen']);
    expect([...new Set((await get({ holding: 'ZERO' })).rows.map((r) => r.item.name))]).toEqual(['Ink', 'Pad']);
    // From only / To only still work.
    expect((await agent.get('/api/ledger').query({ ledger: 'STATIONARY', from: '2025-04-01' })).status).toBe(200);
    expect((await agent.get('/api/ledger').query({ ledger: 'STATIONARY', to: '2025-04-30' })).status).toBe(200);
  });
});

describe('reports', () => {
  it('store balance and handing-taking summaries add up', async () => {
    const agent = await makeUser();
    const it = await newItem(agent, { openingQty: 100, openingDate: '2025-04-01' });
    const pc = await newItem(agent, { name: 'PC', ledger: 'IT', uom: 'Nos' });
    await agent.post('/api/receipts').send(receipt([{ item: it._id, qty: 50, rate: 1 }], { date: '2025-05-02' }));
    await agent.post('/api/receipts').send(receipt([{ item: pc._id, qty: 4, rate: 1 }], { date: '2025-05-02', ledger: 'IT' }));
    await agent.post('/api/issues').send(issue([{ item: it._id, qty: 30, ledgerPageNo: '1' }], { date: '2025-06-02' }));

    const m = await agent.get('/api/reports/store-balance').query({ period: 'monthly', month: '2025-06' });
    const a4 = m.body.rows.find((r) => r.code === 'ST-0001');
    expect(a4).toMatchObject({ opening: 150, receipt: 0, issue: 30, closing: 120 });

    const q = await agent.get('/api/reports/store-balance').query({ period: 'quarterly', fy: '2025-26', quarter: 'Q1' });
    expect(q.body.rows.find((r) => r.code === 'ST-0001')).toMatchObject({ opening: 0, receipt: 150, issue: 30, closing: 120 });

    const h = await agent.get('/api/reports/handing-taking').query({ date: '2026-01-19', fy: '2025-26' });
    expect(h.body.total).toMatchObject({ items: 2, opening: 0, receipt: 154, issue: 30, closing: 124 });
  });
});

describe('backup', () => {
  it('round-trips a backup through restore', async () => {
    const agent = await makeUser();
    await newItem(agent, { openingQty: 7 });
    const backup = (await agent.get('/api/backup')).body;
    expect(backup.format).toBe('mes-store-backup');
    await Item.deleteMany({});
    const res = await agent.post('/api/backup/restore').send(backup);
    expect(res.status).toBe(200);
    const items = await Item.find();
    expect(items).toHaveLength(1);
    expect(items[0].currentStock).toBe(7);
    expect((await agent.get('/api/auth/me')).status).toBe(200);
  });

  it('includes audit attachments, so a restore on a new PC brings the files back too', async () => {
    const agent = await makeUser();
    const obs = (await agent.post('/api/audits').send({ office: 'LAO', date: '2026-10-01', subject: 'Para 1' })).body.observation;
    const PDF = Buffer.from('%PDF-1.4\n%%EOF').toString('base64');
    const pdf = (await agent.post(`/api/audits/${obs._id}/files`).send({ name: 'para.pdf', data: PDF })).body.observation.files[0];

    const backup = JSON.parse(JSON.stringify((await agent.get('/api/backup')).body)); // as written to disk
    expect(backup.version).toBe(2);
    expect(backup.files).toHaveLength(1);

    // Simulate the new PC: nothing there.
    const db = mongoose.connection.db;
    await db.collection('auditFiles.files').deleteMany({});
    await db.collection('auditFiles.chunks').deleteMany({});
    expect((await agent.get(`/api/audits/files/${pdf.fileId}`)).status).toBe(404);

    const res = await agent.post('/api/backup/restore').send(backup);
    expect(res.status).toBe(200);
    expect(res.body.counts).toMatchObject({ auditObservations: 1, files: 1 });
    const file = await agent.get(`/api/audits/files/${pdf.fileId}`).buffer(true).parse((r, cb) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(file.status).toBe(200);
    expect(file.body.toString('base64')).toBe(PDF);
    await db.collection('auditFiles.files').deleteMany({});
    await db.collection('auditFiles.chunks').deleteMany({});
  });

  it('still restores version 1 backups (made before attachments were included)', async () => {
    const agent = await makeUser();
    await newItem(agent, { openingQty: 3 });
    const { files, ...v1 } = (await agent.get('/api/backup')).body;
    await Item.deleteMany({});
    const res = await agent.post('/api/backup/restore').send({ ...v1, version: 1 });
    expect(res.status).toBe(200);
    expect((await Item.find())[0].currentStock).toBe(3);
  });
});

describe('configurable ledgers', () => {
  it('numbers issues from sub-ledgers as Stock Indents, with prefix and next number editable in Settings', async () => {
    const agent = await makeUser();
    await agent.post('/api/settings/ledgers').send({ label: 'Maint Store', prefix: 'MA' });
    await agent.post('/api/settings/ledgers').send({ label: 'B&R Store', prefix: 'BR', parent: 'MAINT_STORE' });
    const cement = await newItem(agent, { name: 'Cement', ledger: 'B_R_STORE', uom: 'Bag', openingQty: 20 });
    const pen = await newItem(agent, { name: 'Pen', openingQty: 5 });

    expect((await agent.get('/api/issues/next-no').query({ ledger: 'B_R_STORE' })).body.next).toBe('SI-000001');
    const si = await agent.post('/api/issues').send(issue([{ item: cement._id, qty: 2, ledgerPageNo: '7' }], { ledger: 'B_R_STORE', issueType: 'Stock Indent' }));
    expect(si.body.issue.issueNo).toBe('SI-000001');
    // Ordinary ledgers keep the normal Issue series.
    const ord = await agent.post('/api/issues').send(issue([{ item: pen._id, qty: 1, ledgerPageNo: '1' }]));
    expect(ord.body.issue.issueNo).toBe('I-000001');

    // Settings: cannot go back over a used number; can move forward and change the prefix.
    expect((await agent.put('/api/settings/stock-indent').send({ prefix: 'SI-', nextNo: 1 })).status).toBe(409);
    const upd = await agent.put('/api/settings/stock-indent').send({ prefix: 'si/ms/', nextNo: 50 });
    expect(upd.body).toMatchObject({ prefix: 'SI/MS/', nextNo: 50 });
    expect((await agent.get('/api/issues/next-no').query({ ledger: 'B_R_STORE' })).body.next).toBe('SI/MS/000050');
    const si2 = await agent.post('/api/issues').send(issue([{ item: cement._id, qty: 1, ledgerPageNo: '7' }], { ledger: 'B_R_STORE', issueType: 'Stock Indent' }));
    expect(si2.body.issue.issueNo).toBe('SI/MS/000050');
    const sk = await makeUser('storekeeper', 'sk3');
    expect((await sk.put('/api/settings/stock-indent').send({ prefix: 'X-', nextNo: 900 })).status).toBe(403);
  });

  it('supports sub-ledgers: the group holds no items, its sub-ledgers work everywhere including reports', async () => {
    const agent = await makeUser();
    await agent.post('/api/settings/ledgers').send({ label: 'Maint Store', prefix: 'MA' });
    const br = await agent.post('/api/settings/ledgers').send({ label: 'B&R Store', prefix: 'BR', parent: 'MAINT_STORE' });
    expect(br.status).toBe(201);
    expect(br.body.ledger).toEqual({ key: 'B_R_STORE', label: 'B&R Store Ledger', prefix: 'BR', parent: 'MAINT_STORE' });
    await agent.post('/api/settings/ledgers').send({ label: 'E&M Store', prefix: 'EM', parent: 'MAINT_STORE' });

    const meta = (await agent.get('/api/settings')).body;
    expect(meta.ledgers.map((l) => l.key)).toEqual(expect.arrayContaining(['B_R_STORE', 'E_M_STORE']));
    expect(meta.ledgers.map((l) => l.key)).not.toContain('MAINT_STORE');
    expect(meta.ledgerGroups).toEqual([expect.objectContaining({ key: 'MAINT_STORE', children: ['B_R_STORE', 'E_M_STORE'] })]);

    // Items go into a sub-ledger, never the group itself.
    expect((await agent.post('/api/items').send({ name: 'Cement', ledger: 'MAINT_STORE', uom: 'Bag' })).status).toBe(400);
    const item = await newItem(agent, { name: 'Cement', ledger: 'B_R_STORE', uom: 'Bag', openingQty: 5 });
    expect(item.code).toBe('BR-0001');
    const bal = await agent.get('/api/reports/stock-statement');
    const ledgersInReport = bal.body.summary.map((s) => s.ledger);
    expect(ledgersInReport).toEqual(expect.arrayContaining(['B_R_STORE', 'E_M_STORE']));
    expect(ledgersInReport).not.toContain('MAINT_STORE');

    // No sub-sub-ledgers; a group cannot be removed while it has sub-ledgers.
    expect((await agent.post('/api/settings/ledgers').send({ label: 'Deep', prefix: 'DP', parent: 'B_R_STORE' })).status).toBe(400);
    expect((await agent.delete('/api/settings/ledgers/MAINT_STORE')).status).toBe(409);
    // A ledger that already has items cannot be divided into sub-ledgers.
    await newItem(agent, { name: 'Pen', ledger: 'STATIONARY' });
    expect((await agent.post('/api/settings/ledgers').send({ label: 'Pens', prefix: 'PN', parent: 'STATIONARY' })).status).toBe(409);
  });

  it('admin can add a ledger and register items in it with its own code prefix', async () => {
    const agent = await makeUser();
    const add = await agent.post('/api/settings/ledgers').send({ label: 'Electrical', prefix: 'el' });
    expect(add.status).toBe(201);
    expect(add.body.ledger).toEqual({ key: 'ELECTRICAL', label: 'Electrical Ledger', prefix: 'EL' });

    const meta = (await agent.get('/api/settings')).body;
    expect(meta.ledgers.map((l) => l.key)).toContain('ELECTRICAL');

    const item = await newItem(agent, { name: 'MCB 32A', ledger: 'ELECTRICAL', uom: 'Nos', openingQty: 10 });
    expect(item.code).toBe('EL-0001');

    const bal = await agent.get('/api/reports/stock-statement').query({ ledger: 'ELECTRICAL' });
    expect(bal.body.summary.find((s) => s.ledger === 'ELECTRICAL')).toMatchObject({ label: 'Electrical Ledger', items: 1, closing: 10 });
  });

  it('rejects duplicate names/prefixes, unknown ledgers and non-admins', async () => {
    const agent = await makeUser();
    expect((await agent.post('/api/settings/ledgers').send({ label: 'Stationary', prefix: 'ZZ' })).status).toBe(409);
    expect((await agent.post('/api/settings/ledgers').send({ label: 'Plumbing', prefix: 'ST' })).status).toBe(409);
    expect((await agent.post('/api/settings/ledgers').send({ label: 'Plumbing', prefix: 'P1' })).status).toBe(400);
    expect((await agent.post('/api/items').send({ name: 'X', ledger: 'NOPE', uom: 'Nos' })).status).toBe(400);
    const sk = await makeUser('storekeeper', 'sk2');
    expect((await sk.post('/api/settings/ledgers').send({ label: 'Plumbing', prefix: 'PL' })).status).toBe(403);
  });

  it('can rename, but only remove a ledger with no items; Loan Store Ledger is protected', async () => {
    const agent = await makeUser();
    await agent.post('/api/settings/ledgers').send({ label: 'Civil', prefix: 'CV' });
    expect((await agent.patch('/api/settings/ledgers/CIVIL').send({ label: 'Civil Works' })).body.ledgers.find((l) => l.key === 'CIVIL').label).toBe('Civil Works Ledger');
    await newItem(agent, { name: 'Cement', ledger: 'CIVIL', uom: 'Kg' });
    expect((await agent.delete('/api/settings/ledgers/CIVIL')).status).toBe(409);
    expect((await agent.delete('/api/settings/ledgers/LOAN')).status).toBe(400);
    await agent.post('/api/settings/ledgers').send({ label: 'Temp', prefix: 'TM' });
    expect((await agent.delete('/api/settings/ledgers/TEMP')).status).toBe(200);
  });
});

describe('loan store (separate Loan Store Ledger)', () => {
  it('lets store keepers add and remove other units and types of store', async () => {
    const agent = await makeUser('storekeeper', 'sk');
    const add = await agent.post('/api/settings/other-offices').send({ name: 'GE Shillong' });
    expect(add.status).toBe(201);
    expect(add.body.otherOffices).toEqual(['GE Shillong']);
    expect((await agent.post('/api/settings/other-offices').send({ name: 'ge shillong' })).status).toBe(409);
    const del = await agent.delete(`/api/settings/other-offices/${encodeURIComponent('GE Shillong')}`);
    expect(del.body.otherOffices).toEqual([]);
    expect((await agent.post('/api/settings/store-types').send({ name: 'Furniture' })).body.storeTypes).toEqual(['Furniture']);
    const viewer = await makeUser('viewer', 'vw');
    expect((await viewer.post('/api/settings/other-offices').send({ name: 'GE Tura' })).status).toBe(403);
  });

  it('issue any item to a section and take it back, in the Loan Store Ledger only', async () => {
    const agent = await makeUser();
    // Items from any ledger; their normal stock must never change.
    const paper = await newItem(agent, { openingQty: 10 });
    const proj = await newItem(agent, { name: 'Projector', ledger: 'IT', uom: 'Nos' });

    const entry = await agent.post('/api/loans/entry').send({ date: '2026-01-02', issueTo: 'GE Shillong', lines: [{ item: proj._id, qty: 2 }] });
    expect(entry.status).toBe(201);
    expect(entry.body.voucher.voucherNo).toBe('LN-O-000001');

    // Any item can be issued, even one that never came in by Store Entry.
    const i1 = (await agent.post('/api/loans/issue').send({ date: '2026-01-05', issueTo: 'Admin Section', qtrNo: 'Q-12', lines: [{ item: paper._id, qty: 4 }, { item: proj._id, qty: 1 }] })).body.voucher;
    expect(i1.voucherNo).toBe('LN-I-000001');
    const i2 = (await agent.post('/api/loans/issue').send({ date: '2026-01-06', issueTo: 'Admin Section', lines: [{ item: paper._id, qty: 2 }] })).body.voucher;

    // Returns name the section and are set against its oldest loan issues first.
    const tooMany = await agent.post('/api/loans/receipt').send({ date: '2026-01-10', issueTo: 'Admin Section', lines: [{ item: paper._id, qty: 7 }] });
    expect(tooMany.status).toBe(400);
    const wrongSection = await agent.post('/api/loans/receipt').send({ date: '2026-01-10', issueTo: 'Works Section', lines: [{ item: paper._id, qty: 1 }] });
    expect(wrongSection.status).toBe(400);
    const ret = await agent.post('/api/loans/receipt').send({ date: '2026-01-10', issueTo: 'admin section', lines: [{ item: paper._id, qty: 5 }] });
    expect(ret.status).toBe(201);
    expect(ret.body.voucher.reference).toBe(`${i1.voucherNo}, ${i2.voucherNo}`);
    const out = (await agent.get('/api/loans/outstanding')).body.rows;
    expect(out.find((r) => r._id === i1._id).returnStatus).toBe('PARTIAL'); // projector still out
    expect(out.find((r) => r._id === i2._id).lines[0].outstanding).toBe(1);

    // Normal stock untouched.
    expect((await Item.findById(paper._id)).currentStock).toBe(10);
    expect((await Item.findById(proj._id)).currentStock).toBe(0);

    const sum = (await agent.get('/api/loans/ledger').query({ from: '2025-04-01', to: '2026-03-31' })).body.rows;
    expect(sum.find((r) => r.item._id === paper._id)).toMatchObject({ received: 0, issued: 6, returned: 5, closing: -1, withSections: 1 });
    expect(sum.find((r) => r.item._id === proj._id)).toMatchObject({ received: 2, issued: 1, closing: 1, withSections: 1 });
    const one = (await agent.get('/api/loans/ledger').query({ from: '2025-04-01', to: '2026-03-31', item: proj._id })).body;
    expect(one.rows.map((r) => r.balance)).toEqual([0, 2, 1]);

    // An item with loan history cannot be deleted.
    expect((await agent.delete(`/api/items/${proj._id}`)).status).toBe(409);

    // Cancelling the receipt puts the returned quantities back on both loan issues.
    expect((await agent.post(`/api/loans/${i1._id}/cancel`).send({ reason: 'mistake' })).status).toBe(409);
    expect((await agent.post(`/api/loans/${ret.body.voucher._id}/cancel`).send({ reason: 'mistake' })).status).toBe(200);
    const after = (await agent.get('/api/loans/outstanding')).body.rows;
    expect(after.find((r) => r._id === i2._id).returnStatus).toBe('ISSUED');
    expect((await agent.post(`/api/loans/${i1._id}/cancel`).send({ reason: 'mistake' })).status).toBe(200);
    expect((await agent.post(`/api/loans/${i2._id}/cancel`).send({ reason: 'mistake' })).status).toBe(200);
    expect((await agent.post(`/api/loans/${entry.body.voucher._id}/cancel`).send({ reason: 'mistake' })).status).toBe(200);
    expect((await agent.get('/api/loans/stock')).body.stock).toEqual({ [paper._id]: 0, [proj._id]: 0 });
  });
});

describe('Loan Store Ledger on Receipt / Issue', () => {
  it('needs no PO / sanction, drops code head and rate, and uses Loan Receipt / Loan Issue numbers', async () => {
    const agent = await makeUser();
    const proj = await newItem(agent, { name: 'Projector', ledger: 'LOAN', uom: 'Nos' });
    expect((await agent.get('/api/receipts/next-no').query({ ledger: 'LOAN' })).body.next).toBe('LR-000001');
    expect((await agent.get('/api/issues/next-no').query({ ledger: 'LOAN' })).body.next).toBe('LI-000001');

    const r = await agent.post('/api/receipts').send({
      date: '2025-05-01', receiptType: 'Purchase', ledger: 'LOAN', loanStoreType: 'Other Items', source: 'GE Shillong',
      lines: [{ item: proj._id, qty: 3, rate: 500, codeHead: '2210' }],
    });
    expect(r.status).toBe(201);
    expect(r.body.receipt.receiptNo).toBe('LR-000001');
    expect(r.body.receipt.poNo).toBe('');
    expect(r.body.receipt.lines[0]).toMatchObject({ rate: 0, codeHead: '' });

    const i = await agent.post('/api/issues').send(issue([{ item: proj._id, qty: 1, ledgerPageNo: '4' }], { ledger: 'LOAN', loanStoreType: 'Other Items' }));
    expect(i.status).toBe(201);
    expect(i.body.issue.issueNo).toBe('LI-000001');

    // Other ledgers still need the PO / sanction and keep the normal series.
    const paper = await newItem(agent);
    const noPo = await agent.post('/api/receipts').send({ ...receipt([{ item: paper._id, qty: 1, rate: 1 }]), poNo: '', poDate: undefined });
    expect(noPo.status).toBe(400);
    expect((await agent.post('/api/receipts').send(receipt([{ item: paper._id, qty: 1, rate: 1 }]))).body.receipt.receiptNo).toMatch(/^R-/);
  });
});

describe('changing an item ledger', () => {
  it('moves an unused item to another ledger with a new code, but not a used one', async () => {
    const agent = await makeUser();
    const it = await newItem(agent, { name: 'Almirah' });
    const body = { name: 'Almirah', ledger: 'LOAN', uom: 'Nos' };
    const moved = await agent.put(`/api/items/${it._id}`).send(body);
    expect(moved.status).toBe(200);
    expect(moved.body.item.code).toBe('LN-0001');
    const used = await newItem(agent, { name: 'Paper', openingQty: 5 });
    expect((await agent.put(`/api/items/${used._id}`).send({ ...body, name: 'Paper' })).status).toBe(409);
  });
});

describe('stock history stays consistent', () => {
  it('refuses an issue dated before the receipt that brought the stock in', async () => {
    const agent = await makeUser();
    const paper = await newItem(agent, { openingQty: 10, openingDate: '2025-05-01' });
    const early = await agent.post('/api/issues').send(issue([{ item: paper._id, qty: 4, ledgerPageNo: '1' }], { date: '2025-04-15' }));
    expect(early.status).toBe(400);
    expect(early.body.error).toMatch(/below zero on 15-04-2025/);
    expect((await agent.get(`/api/items/${paper._id}`)).body.item.currentStock).toBe(10);
    // Same quantity on or after the receipt date is fine.
    expect((await agent.post('/api/issues').send(issue([{ item: paper._id, qty: 4, ledgerPageNo: '1' }]))).status).toBe(201);
  });

  it('edits a receipt whose items were partly issued, but not below what was issued or before the issue date', async () => {
    const agent = await makeUser();
    const paper = await newItem(agent);
    const r = await agent.post('/api/receipts').send(receipt([{ item: paper._id, qty: 50, rate: 10 }]));
    expect((await agent.post('/api/issues').send(issue([{ item: paper._id, qty: 30, ledgerPageNo: '1' }]))).status).toBe(201);

    const edit = (qty, extra) => agent.put(`/api/receipts/${r.body.receipt._id}`).send(receipt([{ item: paper._id, qty, rate: 10 }], extra));
    expect((await edit(60)).status).toBe(200);
    expect((await agent.get(`/api/items/${paper._id}`)).body.item.currentStock).toBe(30);
    expect((await edit(20)).status).toBe(400); // 30 already issued
    expect((await edit(60, { date: '2025-05-20' })).status).toBe(400); // after the issue of 10 May
    expect((await agent.get(`/api/items/${paper._id}`)).body.item).toMatchObject({ currentStock: 30, avgRate: 10 });
    // Cancelling it would leave the issue unsupported.
    expect((await agent.post(`/api/receipts/${r.body.receipt._id}/cancel`).send({ reason: 'wrong entry' })).status).toBe(400);
  });

  it('shows Loan Store Ledger balances on items, low stock, dashboard and store balance reports', async () => {
    const agent = await makeUser();
    const proj = (await agent.post('/api/items').send({ name: 'Projector', ledger: 'LOAN', uom: 'Nos', minStock: 1 })).body.item;
    await agent.post('/api/receipts').send(receipt([{ item: proj._id, qty: 4 }], { ledger: 'LOAN', loanStoreType: 'Other Items', poNo: '', poDate: undefined }));
    await agent.post('/api/loans/issue').send({ date: '2025-05-02', issueTo: 'Works', lines: [{ item: proj._id, qty: 1 }] });

    expect((await agent.get(`/api/items/${proj._id}`)).body.item.currentStock).toBe(3);
    expect((await agent.get('/api/items?ledger=LOAN')).body.items[0].currentStock).toBe(3);
    expect((await agent.get('/api/reports/low-stock')).body.rows.map((x) => x.code)).not.toContain(proj.code);
    expect((await agent.get('/api/dashboard')).body.counts.lowStock).toBe(0);
    const astb = await agent.get('/api/reports/store-balance?period=yearly&fy=2025-26');
    expect(astb.body.summary.find((s) => s.ledger === 'LOAN')).toMatchObject({ receipt: 4, issue: 1, closing: 3 });
    expect(astb.body.rows.find((x) => x.code === proj.code)).toMatchObject({ opening: 0, receipt: 4, issue: 1, closing: 3 });
  });

  it('cancelling a loan voucher keeps the Loan Store balance equal to its ledger', async () => {
    const agent = await makeUser();
    const chair = (await agent.post('/api/items').send({ name: 'Chair', ledger: 'LOAN', uom: 'Nos' })).body.item;
    const entry = await agent.post('/api/loans/entry').send({ date: '2025-05-01', issueTo: 'GE One', lines: [{ item: chair._id, qty: 5 }] });
    const loan = await agent.post('/api/loans/issue').send({ date: '2025-05-02', issueTo: 'Works', lines: [{ item: chair._id, qty: 2 }] });
    await agent.post(`/api/loans/${loan.body.voucher._id}/cancel`).send({ reason: 'mistake' });
    expect((await agent.get('/api/loans/stock')).body.stock[chair._id]).toBe(5);
    await agent.post(`/api/loans/${entry.body.voucher._id}/cancel`).send({ reason: 'mistake' });
    expect((await agent.get('/api/loans/stock')).body.stock[chair._id]).toBe(0);
    const ledger = await agent.get(`/api/loans/ledger?from=2025-04-01&to=2026-03-31&item=${chair._id}`);
    expect(ledger.body.closing).toBe(0);
  });
});

describe('audit observations', () => {
  const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF').toString('base64');
  const DOCX = Buffer.from('PK\u0003\u0004 fake docx').toString('base64');

  it('records an observation with files, replies and status, and serves the files', async () => {
    const agent = await makeUser();
    const created = await agent.post('/api/audits').send({ office: 'LAO', paraNo: '3(a)', letterNo: 'LAO/SHG/2026/41', letterDate: '2026-09-28', date: '2026-10-01', subject: 'Stock register not updated', observation: 'Paper A4 balance differs', ledger: 'STATIONARY', reference: 'R-000001' });
    expect(created.status).toBe(201);
    const obs = created.body.observation;
    expect(obs).toMatchObject({ obsNo: 'AO-000001', status: 'OPEN', letterNo: 'LAO/SHG/2026/41' });
    expect(obs.letterDate).toBeTruthy();

    const withPdf = await agent.post(`/api/audits/${obs._id}/files`).send({ name: 'LAO para 3a.pdf', data: PDF });
    expect(withPdf.status).toBe(201);
    const pdf = withPdf.body.observation.files[0];
    expect(pdf).toMatchObject({ name: 'LAO para 3a.pdf', type: 'application/pdf' });
    // Not allowed / disguised files are refused.
    expect((await agent.post(`/api/audits/${obs._id}/files`).send({ name: 'x.exe', data: PDF })).status).toBe(400);
    expect((await agent.post(`/api/audits/${obs._id}/files`).send({ name: 'fake.pdf', data: DOCX })).status).toBe(400);

    const file = await agent.get(`/api/audits/files/${pdf.fileId}`).buffer(true).parse((res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(file.body.toString('latin1').startsWith('%PDF')).toBe(true);

    const rep = await agent.post(`/api/audits/${obs._id}/replies`).send({ date: '2026-10-05', letterRef: 'MES/ST/2026/77', text: 'Register updated; copy enclosed.' });
    expect(rep.body.observation.replies[0].letterRef).toBe('MES/ST/2026/77');
    expect((await agent.get('/api/audits').query({ q: 'MES/ST/2026' })).body.rows).toHaveLength(1);
    expect(rep.body.observation.status).toBe('REPLIED');
    const withReplyFile = await agent.post(`/api/audits/${obs._id}/files`).send({ name: 'Reply.docx', data: DOCX, replyId: rep.body.replyId });
    expect(withReplyFile.body.observation.replies[0].files[0].name).toBe('Reply.docx');

    const settled = await agent.patch(`/api/audits/${obs._id}/status`).send({ status: 'SETTLED' });
    expect(settled.body.observation.status).toBe('SETTLED');
    const list = await agent.get('/api/audits').query({ office: 'LAO', q: 'register' });
    expect(list.body.rows.map((r) => r.obsNo)).toEqual(['AO-000001']);

    const viewer = await makeUser('viewer', 'v1');
    expect((await viewer.post('/api/audits').send({ office: 'CAG', date: '2026-10-01', subject: 'x' })).status).toBe(403);
    expect((await viewer.get(`/api/audits/files/${pdf.fileId}`)).status).toBe(200);

    expect((await agent.delete(`/api/audits/${obs._id}`)).status).toBe(200);
    expect((await agent.get(`/api/audits/files/${pdf.fileId}`)).status).toBe(404);
  });
});

describe('deleting cancelled vouchers', () => {
  it('lets an admin delete only cancelled receipts / issues / loan vouchers', async () => {
    const agent = await makeUser();
    const pen = await newItem(agent, { name: 'Pen', openingQty: 10 });
    const r = (await agent.post('/api/receipts').send(receipt([{ item: pen._id, qty: 2, rate: 5 }]))).body.receipt;
    expect((await agent.delete(`/api/receipts/${r._id}`)).status).toBe(400); // still posted
    await agent.post(`/api/receipts/${r._id}/cancel`).send({ reason: 'Wrong entry' });
    const sk = await makeUser('storekeeper', 'sk9');
    expect((await sk.delete(`/api/receipts/${r._id}`)).status).toBe(403); // admin only
    expect((await agent.delete(`/api/receipts/${r._id}`)).status).toBe(200);
    expect((await agent.get(`/api/receipts/${r._id}`)).status).toBe(404);

    const i = (await agent.post('/api/issues').send(issue([{ item: pen._id, qty: 1, ledgerPageNo: '1' }]))).body.issue;
    await agent.post(`/api/issues/${i._id}/cancel`).send({ reason: 'Duplicate' });
    expect((await agent.delete(`/api/issues/${i._id}`)).status).toBe(200);
    expect((await Item.findById(pen._id)).currentStock).toBe(10); // stock untouched by the delete
  });

  it('deletes a cancelled loan issue; a posted one is refused', async () => {
    const agent = await makeUser();
    const chair = (await agent.post('/api/items').send({ name: 'Chair', ledger: 'LOAN', uom: 'Nos' })).body.item;
    await agent.post('/api/loans/entry').send({ date: '2026-01-02', issueTo: 'GE Shillong', lines: [{ item: chair._id, qty: 5 }] });
    const loan = (await agent.post('/api/loans/issue').send({ date: '2026-01-05', issueTo: 'Works', lines: [{ item: chair._id, qty: 2 }] })).body.voucher;
    expect((await agent.delete(`/api/loans/${loan._id}`)).status).toBe(400); // posted
    await agent.post(`/api/loans/${loan._id}/cancel`).send({ reason: 'Wrong section' });
    expect((await agent.delete(`/api/loans/${loan._id}`)).status).toBe(200);
    expect((await agent.get(`/api/loans/${loan._id}`)).status).toBe(404);
    expect((await agent.get('/api/loans/stock')).body.stock[chair._id]).toBe(5);
  });
});

describe('orders (stand-alone purchase order record)', () => {
  it('Payments (MER): totals per code head per month of the FY, by payment date, without cancelled orders', async () => {
    const agent = await makeUser();
    const pay = (codeHead, paymentDate, paymentAmount, extra = {}) =>
      agent.post('/api/orders').send({
        mode: 'GeM', orderDate: '2026-04-02', vendor: 'M/S Raj', codeHead, orderValue: paymentAmount,
        billForwardedOn: '2026-04-03', paymentDate, paymentAmount, ...extra,
      });
    await pay('2305', '2026-04-20', 1000);
    await pay('2305', '2026-04-25', 500.5);
    await pay('2305', '2027-03-31', 200); // last day of FY 2026-27
    await pay('2210', '2026-07-01', 300);
    await pay('', '2026-07-15', 50); // no code head
    await pay('2210', '2027-04-01', 999); // next FY
    await pay('2210', '2026-07-02', 777, { cancelled: true });
    await agent.post('/api/orders').send({ mode: 'GeM', orderDate: '2026-05-01', vendor: 'Unpaid', codeHead: '2305', orderValue: 10 });

    const res = await agent.get('/api/orders/payments').query({ fy: '2026-27' });
    expect(res.status).toBe(200);
    expect(res.body.months.map((m) => m.key)).toEqual(['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03']);
    expect(res.body.rows.map((r) => r.codeHead)).toEqual(['2210', '2305', '']);
    const h2305 = res.body.rows.find((r) => r.codeHead === '2305');
    expect(h2305.months[0]).toBe(1500.5);
    expect(h2305.months[11]).toBe(200);
    expect(h2305.total).toBe(1700.5);
    expect(res.body.rows.find((r) => r.codeHead === '2210').months[3]).toBe(300);
    expect(res.body.totals).toMatchObject({ total: 2050.5, payments: 5 });
    expect(res.body.totals.months[3]).toBe(350);
    expect(res.body.payments).toHaveLength(5);
    expect((await agent.get('/api/orders/payments').query({ fy: '2026' })).status).toBe(400);
  });

  it('records demand, approval, order, bill and payment; status follows the dates; no stock is touched', async () => {
    const agent = await makeUser();
    const base = {
      mode: 'GeM', supplyOrderNo: 'GEMC-511687-7000-01', orderDate: '2026-06-10', vendor: 'M/S Raj Enterprises',
      demandNo: 'DMD/ST/12', demandDate: '2026-05-20', demandFrom: 'Works Section',
      approvalDate: '2026-06-01', notingNo: 'NOTE/45', notingDate: '2026-05-28', codeHead: '2305',
      lines: [{ description: 'Paper A4 75 GSM', qty: 50, uom: 'Ream', rate: 300 }, { description: 'Stapler', qty: 5, uom: 'Nos', rate: 120 }],
    };
    const o = (await agent.post('/api/orders').send(base)).body.order;
    expect(o).toMatchObject({ orderNo: 'ORD-000001', orderValue: 15600, status: 'ORDERED' });

    const billed = (await agent.put(`/api/orders/${o._id}`).send({ ...base, deliveredOn: '2026-06-25', billNo: 'INV-88', billDate: '2026-06-25', billAmount: 15600, billForwardedOn: '2026-06-28', accountsOffice: 'PCDA', forwardingLetterNo: 'MES/ACC/301' })).body.order;
    expect(billed.status).toBe('BILL_FORWARDED');
    expect((await agent.put(`/api/orders/${o._id}`).send({ ...base, billForwardedOn: '2026-06-28', paymentDate: '2026-06-20' })).status).toBe(400); // paid before forwarded
    const paid = (await agent.put(`/api/orders/${o._id}`).send({ ...base, deliveredOn: '2026-06-25', billNo: 'INV-88', billDate: '2026-06-25', billAmount: 15600, billForwardedOn: '2026-06-28', paymentDate: '2026-07-15', paymentAmount: 15600, paymentRef: 'DV-77' })).body.order;
    expect(paid.status).toBe('PAID');

    expect(o.budgetYear).toBe('2026-27'); // defaults to the order date's financial year
    expect((await agent.get('/api/orders').query({ fy: '2026-27' })).body.rows).toHaveLength(1);
    expect((await agent.get('/api/orders').query({ fy: '2025-26' })).body.rows).toHaveLength(0);
    expect((await agent.post('/api/orders').send({ ...base, budgetYear: '2026' })).status).toBe(400);
    const report = (await agent.get('/api/orders').query({ mode: 'GeM', q: 'Paper' })).body;
    expect(report.totals).toMatchObject({ orders: 1, orderValue: 15600, paymentAmount: 15600 });
    expect((await agent.get('/api/orders').query({ status: 'PENDING_PAYMENT' })).body.rows).toHaveLength(0);
    expect((await agent.delete(`/api/orders/${o._id}`)).status).toBe(400); // payment recorded
    expect(await Item.countDocuments()).toBe(0); // stand-alone: no items / stock created
    // "Project contingency" needs the Office; other code heads never keep one.
    const pc = { ...base, codeHead: 'Project contingency' };
    expect((await agent.post('/api/orders').send(pc)).status).toBe(400);
    expect((await agent.post('/api/orders').send({ ...pc, projectOffice: 'GE (P) Shillong' })).body.order.projectOffice).toBe('GE (P) Shillong');
    expect((await agent.post('/api/orders').send({ ...base, projectOffice: 'GE (P) Shillong' })).body.order.projectOffice).toBe('');
  });
});

describe('orders import (GeM / Excel / Word)', () => {
  it('creates new orders, updates existing ones by order number (no duplicates), and previews with dryRun', async () => {
    const agent = await makeUser();
    const gem = { supplyOrderNo: 'GEMC-511687700000001', orderDate: '2026-11-05', vendor: 'M/S Raj Enterprises', lines: [{ description: 'Paper A4', qty: 50, uom: 'Ream', rate: 300 }] };
    const preview = (await agent.post('/api/orders/import').send({ orders: [gem], dryRun: true })).body.plan;
    expect(preview[0]).toMatchObject({ action: 'create', orderValue: 15000 });
    expect((await agent.get('/api/orders')).body.rows).toHaveLength(0); // dry run saved nothing

    const first = (await agent.post('/api/orders/import').send({ orders: [gem] })).body.plan[0];
    expect(first).toMatchObject({ action: 'create', orderNo: 'ORD-000001' });
    // Typed by hand later — must survive a re-import.
    const saved = (await agent.get('/api/orders')).body.rows[0];
    await agent.put(`/api/orders/${saved._id}`).send({ mode: 'GeM', supplyOrderNo: gem.supplyOrderNo, orderDate: '2026-11-05', vendor: gem.vendor, notingNo: 'NOTE/9', lines: gem.lines });

    // Same contract no. again (different spacing / case) → update, never a second order.
    const again = { ...gem, supplyOrderNo: ' gemc-511687700000001 ', billNo: 'INV-5', billDate: '2026-11-15', billAmount: 15000 };
    const plan = (await agent.post('/api/orders/import').send({ orders: [again, { ...gem }, { vendor: 'No number' }] })).body.plan;
    expect(plan.map((p) => p.action)).toEqual(['update', 'error', 'error']); // dup in file, missing number
    const rows = (await agent.get('/api/orders')).body.rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ orderNo: 'ORD-000001', billNo: 'INV-5', notingNo: 'NOTE/9' });
  });
});

describe('item import', () => {
  it('creates new items, updates existing ones by code or name, and never duplicates', async () => {
    const agent = await makeUser();
    const pen = await newItem(agent, { name: 'Ball Pen', description: 'Blue' });
    const rows = [
      { name: 'Paper A4', uom: 'Ream', ledgerPage: '12', category: 'Consumable', minStock: '5' },
      { name: ' ball pen ', description: 'BLUE', uom: 'Box' }, // same as existing (case / spacing)
      { name: 'Mouse', ledger: 'IT Ledger', uom: 'Nos' }, // ledger given by label
      { name: 'Paper A4', uom: 'Ream' }, // twice in file
      { name: 'Ghost', ledger: 'No Such Ledger' },
      { description: 'no name' },
    ];
    const preview = (await agent.post('/api/items/import').send({ ledger: 'STATIONARY', items: rows, dryRun: true })).body.plan;
    expect(preview.map((p) => p.action)).toEqual(['create', 'update', 'create', 'error', 'error', 'error']);
    expect((await agent.get('/api/items')).body.items).toHaveLength(1); // dry run saved nothing

    const plan = (await agent.post('/api/items/import').send({ ledger: 'STATIONARY', items: rows })).body.plan;
    expect(plan[0].code).toMatch(/^ST-/);
    expect(plan[2]).toMatchObject({ ledger: 'IT', action: 'create' });
    const items = (await agent.get('/api/items')).body.items;
    expect(items).toHaveLength(3);
    expect(items.find((i) => i._id === pen._id).uom).toBe('Box');
    expect(items.find((i) => i.name === 'Paper A4')).toMatchObject({ ledgerPage: '12', category: 'CONSUMABLE', minStock: 5, currentStock: 0 });

    // Re-import of an export (by code) changes nothing new.
    const again = (await agent.post('/api/items/import').send({ items: items.map(({ code, name, uom }) => ({ code, name, uom })) })).body.plan;
    expect(again.every((p) => p.action === 'same')).toBe(true);
    expect((await agent.get('/api/items')).body.items).toHaveLength(3);
  });
});

describe('demands', () => {
  it('records a demand for items of any ledger without touching stock', async () => {
    const agent = await makeUser();
    const paper = await newItem(agent, { name: 'Paper A4', openingQty: 10 });
    const pc = await newItem(agent, { name: 'Desktop PC', ledger: 'IT', uom: 'Nos' });
    expect((await agent.get('/api/demands/next-no')).body.next).toBe('DMD-000001');
    const d = (await agent.post('/api/demands').send({ date: '2026-11-21', unit: 'Works Section', subSection: 'B/R', authority: 'AGE (B/R)', demandedTo: 'The GE, MES Shillong', frequency: 'Monthly', lines: [{ item: paper._id, qty: 5, rate: 310.5 }, { item: pc._id, qty: 1, remarks: 'Urgent' }] })).body.demand;
    expect(d).toMatchObject({ demandedTo: 'The GE, MES Shillong', frequency: 'Monthly' });
    expect(d.lines.map((l) => l.rate)).toEqual([310.5, 0]);
    expect(d).toMatchObject({ demandNo: 'DMD-000001', unit: 'Works Section', subSection: 'B/R' });
    expect(d.lines.map((l) => [l.item.name, l.item.uom, l.qty])).toEqual([['Paper A4', 'Ream', 5], ['Desktop PC', 'Nos', 1]]);
    expect((await Item.findById(paper._id)).currentStock).toBe(10); // stock untouched
    expect((await agent.post('/api/demands').send({ date: '2026-11-21', unit: 'Works', lines: [{ item: paper._id, qty: 1 }, { item: paper._id, qty: 2 }] })).status).toBe(400);
    expect((await agent.get('/api/demands').query({ q: 'AGE (B/R)' })).body.rows).toHaveLength(1);
  });
});

describe('consolidated demands', () => {
  it('combines section demands, marks them consolidated, and frees them again on delete', async () => {
    const agent = await makeUser();
    const paper = await newItem(agent, { name: 'Paper A4' });
    const pen = await newItem(agent, { name: 'Pen' });
    const d1 = (await agent.post('/api/demands').send({ date: '2026-11-20', unit: 'Admin Section', lines: [{ item: paper._id, qty: 10 }] })).body.demand;
    const d2 = (await agent.post('/api/demands').send({ date: '2026-11-21', unit: 'Works Section', lines: [{ item: paper._id, qty: 5 }, { item: pen._id, qty: 20 }] })).body.demand;
    expect((await agent.get('/api/demands').query({ consolidated: 'no' })).body.rows).toHaveLength(2);

    const cd = (await agent.post('/api/consolidated-demands').send({
      date: '2026-11-21', forwardedTo: 'Procurement Section', codeHead: '2305 – Stationery', sourceDemands: [d1._id, d2._id],
      lines: [
        { item: paper._id, qty: 15, breakdown: [{ demandNo: d1.demandNo, unit: 'Admin Section', qty: 10 }, { demandNo: d2.demandNo, unit: 'Works Section', qty: 5 }] },
        { item: pen._id, qty: 20, rate: 8 },
      ],
    })).body.consolidated;
    expect(cd).toMatchObject({ cdNo: 'CDM-000001', forwardedTo: 'Procurement Section', codeHead: '2305 – Stationery' });
    expect(cd.lines[0].breakdown).toHaveLength(2);
    expect(cd.sourceDemands.map((s) => s.demandNo).sort()).toEqual([d1.demandNo, d2.demandNo].sort());
    expect((await agent.get('/api/demands').query({ consolidated: 'no' })).body.rows).toHaveLength(0);
    expect((await agent.get(`/api/demands/${d1._id}`)).body.demand.consolidatedIn.no).toBe('CDM-000001');

    // Editing it to drop a source frees that demand; deleting frees the rest.
    await agent.put(`/api/consolidated-demands/${cd._id}`).send({ date: '2026-11-21', sourceDemands: [d1._id], lines: [{ item: paper._id, qty: 10 }] });
    expect((await agent.get('/api/demands').query({ consolidated: 'no' })).body.rows.map((r) => r.demandNo)).toEqual([d2.demandNo]);
    await agent.delete(`/api/consolidated-demands/${cd._id}`);
    expect((await agent.get('/api/demands').query({ consolidated: 'no' })).body.rows).toHaveLength(2);
  });
});

describe('DCS (Demand → DCS)', () => {
  const PDF = Buffer.from('%PDF-1.4\n%%EOF').toString('base64');

  it('records header and items, computes amounts, attaches rate quotations, and is in the backup', async () => {
    const agent = await makeUser();
    const created = await agent.post('/api/dcs').send({
      date: '2026-11-23', unit: 'GE (N) Shillong', jobNo: 'JOB/26/14', jobDescription: 'Repair of office block',
      nameOfWork: 'Painting', authority: 'CWE letter 1234/W dated 01 Nov 2026',
      lines: [
        { nameOfWork: 'Painting', description: 'Enamel paint, white', uom: 'Ltr', qty: 20, rate: 310.5 },
        { description: 'Brush 4"', uom: 'Nos', qty: 3, rate: 95, remarks: 'Local purchase' },
      ],
    });
    expect(created.status).toBe(201);
    const d = created.body.dcs;
    expect(d).toMatchObject({ dcsNo: 'DCS-000001', jobNo: 'JOB/26/14', totalAmount: 6495 });
    expect(d.lines.map((l) => l.amount)).toEqual([6210, 285]);
    expect((await agent.post('/api/dcs').send({ date: '2026-11-23', lines: [{ description: '' }] })).status).toBe(400);

    const withFile = await agent.post(`/api/dcs/${d._id}/files`).send({ name: 'Quotation M-s ABC.pdf', data: PDF });
    expect(withFile.status).toBe(201);
    const file = withFile.body.dcs.files[0];
    expect((await agent.get(`/api/dcs/files/${file.fileId}`)).status).toBe(200);
    expect((await agent.post(`/api/dcs/${d._id}/files`).send({ name: 'x.exe', data: PDF })).status).toBe(400);

    const upd = await agent.put(`/api/dcs/${d._id}`).send({ date: '2026-11-24', jobNo: 'JOB/26/14', lines: [{ description: 'Enamel paint', qty: 2, rate: 100 }] });
    expect(upd.body.dcs).toMatchObject({ totalAmount: 200 });
    expect(upd.body.dcs.files).toHaveLength(1); // editing keeps the quotations
    expect((await agent.get('/api/dcs').query({ q: 'JOB/26' })).body.rows).toHaveLength(1);

    const backup = (await agent.get('/api/backup')).body;
    expect(backup.data.dcs).toHaveLength(1);
    expect(backup.files.map((f) => String(f._id))).toContain(String(file.fileId));

    const viewer = await makeUser('viewer', 'dcsviewer');
    expect((await viewer.post('/api/dcs').send({ date: '2026-11-23', lines: [{ description: 'x' }] })).status).toBe(403);

    const del = await agent.delete(`/api/dcs/${d._id}`);
    expect(del.status).toBe(200);
    expect((await agent.get(`/api/dcs/files/${file.fileId}`)).status).toBe(404);
  });

  it('a line can come from the Item Master of any ledger, with more description typed after it', async () => {
    const agent = await makeUser();
    const item = await newItem(agent, { name: 'Cement OPC 43', ledger: 'STATIONARY', uom: 'Bag' });
    const res = await agent.post('/api/dcs').send({ date: '2026-11-23', lines: [{ item: item._id, description: 'Cement OPC 43 – Ultratech or equivalent, fresh stock', uom: 'Bag', qty: 10, rate: 400 }] });
    expect(res.status).toBe(201);
    expect(res.body.dcs.lines[0]).toMatchObject({ item: item._id, description: 'Cement OPC 43 – Ultratech or equivalent, fresh stock', amount: 4000 });
  });

  it('signature blocks are set in Settings, can be removed, and start with defaults', async () => {
    const agent = await makeUser();
    const meta = (await agent.get('/api/settings')).body.settings;
    expect(meta.dcsSignatures.map((s) => s.title)).toEqual(['Store I/C', 'Officer in Charge']);
    expect(meta.dcsTitle).toBe('DRAFTED COSTED SCHEDULED');
    const base = { ...meta };
    for (const k of ['_id', 'createdAt', 'updatedAt', 'ledgers', 'stockIndent']) delete base[k];
    const put = await agent.put('/api/settings').send({ ...base, dcsSignatures: [{ title: 'Prepared By', name: 'R. Kumar', designation: 'JE (Civ)' }] });
    expect(put.status).toBe(200);
    expect(put.body.settings.dcsSignatures).toEqual([{ title: 'Prepared By', name: 'R. Kumar', designation: 'JE (Civ)' }]);
    expect((await agent.put('/api/settings').send({ ...base, dcsTitle: 'DETAILED COST STATEMENT (DCS)' })).body.settings.dcsTitle).toBe('DETAILED COST STATEMENT (DCS)');
    expect((await agent.put('/api/settings').send({ ...base, dcsSignatures: [] })).body.settings.dcsSignatures).toEqual([]);
    expect((await agent.put('/api/settings').send({ ...base, dcsSignatures: [{ title: '' }] })).status).toBe(400);
  });
});
