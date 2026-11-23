// Move the Loan Store onto its own separate ledger (LoanTxn / LoanStock).
//
// Before: loan vouchers and Loan Store Ledger items moved normal stock (Item.currentStock / StockTxn).
// After:  the same movements live in the separate Loan Store Ledger, and the normal ledger rows
//         for the Loan Store are removed so the quantities are not counted twice.
//
// Usage:  npm run migrate:loan-store              (dry run: shows what would change)
//         npm run migrate:loan-store -- --apply   (saves a JSON backup of everything touched first)
import fs from 'node:fs';
import path from 'node:path';
import env from '../src/config/env.js';
import { connectDb, disconnectDb } from '../src/db.js';
import Item from '../src/models/Item.js';
import StockTxn from '../src/models/StockTxn.js';
import { LoanVoucher, Receipt, Issue } from '../src/models/Voucher.js';
import { LoanTxn, LoanStock } from '../src/models/Loan.js';
import { LOAN_LEDGER } from '../src/config/constants.js';
import { withTxn } from '../src/services/stock.js';

const round3 = (n) => Math.round(n * 1000) / 1000;
const TYPE = { LOAN_ISSUE: 'LOAN_ISSUE', LOAN_RETURN: 'LOAN_RETURN', LOAN_IN: 'STORE_ENTRY', RECEIPT: 'RECEIPT', ISSUE: 'ISSUE' };

async function main() {
  const apply = process.argv.includes('--apply');
  await connectDb(env.MONGODB_URI);

  const loanItems = await Item.find({ ledger: LOAN_LEDGER }).lean();
  const loanItemIds = loanItems.map((i) => i._id);
  const txns = await StockTxn.find({
    $or: [{ ledger: LOAN_LEDGER }, { item: { $in: loanItemIds } }, { voucherType: { $in: ['LOAN_ISSUE', 'LOAN_RETURN', 'LOAN_IN'] } }],
  })
    .sort({ date: 1, createdAt: 1, seq: 1 })
    .lean();
  const vouchers = await LoanVoucher.find({ loanLedger: { $ne: true } }).lean();

  if (!txns.length && !vouchers.length) {
    console.log('Nothing to migrate: the Loan Store already uses its own ledger.');
    return disconnectDb();
  }

  // Receipt / Issue vouchers made for the Loan Store Ledger also move across.
  const loanReceipts = await Receipt.find({ ledger: LOAN_LEDGER }, { source: 1 }).lean();
  const loanIssues = await Issue.find({ ledger: LOAN_LEDGER }, { issueTo: 1 }).lean();
  const party = new Map([
    ...vouchers.map((v) => [v._id.toString(), v.issueTo]),
    ...loanReceipts.map((v) => [v._id.toString(), v.source]),
    ...loanIssues.map((v) => [v._id.toString(), v.issueTo]),
  ]);
  const rows = txns.map((t) => ({
    date: t.date,
    item: t.item,
    type: TYPE[t.voucherType] || 'OPENING',
    voucherNo: t.voucherNo,
    voucherId: t.voucherId,
    party: party.get(t.voucherId?.toString()) || '',
    inQty: t.receiptQty || 0,
    outQty: t.issueQty || 0,
    remarks: TYPE[t.voucherType] ? t.remarks : `Carried over (${t.voucherType} ${t.voucherNo})`.trim(),
    seq: t.seq || 0,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  }));

  const balance = new Map();
  for (const r of rows) balance.set(r.item.toString(), round3((balance.get(r.item.toString()) || 0) + r.inQty - r.outQty));
  const items = await Item.find({ _id: { $in: [...balance.keys()] } }).lean();
  const nameOf = new Map(items.map((i) => [i._id.toString(), `${i.code}  ${i.name}`]));

  console.log(`Loan vouchers to mark as Loan Store Ledger: ${vouchers.map((v) => v.voucherNo).join(', ') || 'none'}`);
  console.log(`Ledger rows to move into the Loan Store Ledger: ${rows.length}`);
  console.log('\nLoan Store balances after migration:');
  let mismatch = false;
  for (const [id, qty] of balance) {
    const item = items.find((i) => i._id.toString() === id);
    const isLoanItem = item?.ledger === LOAN_LEDGER;
    const note = isLoanItem && item.currentStock !== qty ? `   (!) normal stock shows ${item.currentStock}` : '';
    if (note) mismatch = true;
    console.log(`  ${nameOf.get(id) || id}  ->  ${qty}${note}`);
  }
  console.log(`\nNormal stock of Loan Store Ledger items will be set to 0 (${loanItems.length} item(s)); other ledgers are not changed.`);
  const foreign = rows.filter((r) => !loanItemIds.some((x) => x.equals(r.item)));
  if (foreign.length) console.log(`(!) ${foreign.length} loan row(s) are for items outside the Loan Store Ledger; their normal stock is NOT changed.`);
  if (mismatch) console.log('(!) A balance does not match the item\'s current stock. Check before applying.');

  if (!apply) {
    console.log('\nDry run only. Pass --apply to save.');
    return disconnectDb();
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.resolve(process.cwd(), '..', '.data', `loan-migration-backup-${stamp}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ items: loanItems, stockTxns: txns, loanVouchers: vouchers }, null, 2));
  console.log(`\nBackup written to ${file}`);

  await withTxn(async (session) => {
    if (rows.length) await LoanTxn.insertMany(rows, { session, ordered: true });
    for (const [id, qty] of balance) {
      await LoanStock.updateOne({ item: id }, { $inc: { qty } }, { upsert: true, session });
    }
    await StockTxn.deleteMany({ _id: { $in: txns.map((t) => t._id) } }, { session });
    await Item.updateMany({ ledger: LOAN_LEDGER }, { $set: { currentStock: 0 } }, { session });
    await LoanVoucher.updateMany({ loanLedger: { $ne: true } }, { $set: { loanLedger: true } }, { session });
    // Loan Store Ledger receipts / issues carry no value.
    for (const Model of [Receipt, Issue]) {
      await Model.updateMany({ ledger: LOAN_LEDGER }, { $set: { totalAmount: 0, 'lines.$[].rate': 0, 'lines.$[].amount': 0 } }, { session });
    }
  });
  console.log('Migration applied.');
  await disconnectDb();
}

main().then(
  // Exit explicitly: open handles (timers, the IPC channel of an Electron utility
  // process) can otherwise keep the process alive after the work is done.
  () => process.exit(process.exitCode ?? 0),
  async (e) => {
    console.error(e.message);
    await disconnectDb().catch(() => {});
    process.exit(1);
  },
);
