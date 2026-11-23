// Check (and optionally repair) the cached stock balances against the ledgers they are built from.
//
//   Item.currentStock  must equal the sum of the item's Master Ledger rows (StockTxn)
//   LoanStock.qty      must equal the sum of the item's Loan Store Ledger rows (LoanTxn)
//
// The ledgers are the record; the cached balances are only there for fast stock checks, so a
// mismatch is repaired by recomputing the cache from the ledger. Also reports any item whose
// Master Ledger balance drops below zero on some date (needs a voucher date corrected by hand).
//
// Usage:  npm run reconcile                (dry run: lists what is wrong)
//         npm run reconcile -- --apply     (saves a JSON backup of what it changes in ../.data first)
import fs from 'node:fs';
import path from 'node:path';
import env from '../src/config/env.js';
import { connectDb, disconnectDb } from '../src/db.js';
import Item from '../src/models/Item.js';
import StockTxn from '../src/models/StockTxn.js';
import { LoanTxn, LoanStock } from '../src/models/Loan.js';
import { withTxn } from '../src/services/stock.js';

const round3 = (n) => Math.round((n + Number.EPSILON) * 1000) / 1000;

async function main() {
  const apply = process.argv.includes('--apply');
  await connectDb(env.MONGODB_URI);

  const items = await Item.find().lean();
  const nameOf = new Map(items.map((i) => [i._id.toString(), `${i.code} ${i.name}`]));

  const stockSums = new Map(
    (await StockTxn.aggregate([{ $group: { _id: '$item', bal: { $sum: { $subtract: ['$receiptQty', '$issueQty'] } } } }])).map((a) => [
      a._id.toString(),
      round3(a.bal),
    ]),
  );
  const itemFixes = items
    .map((i) => ({ item: i, want: stockSums.get(i._id.toString()) || 0 }))
    .filter(({ item, want }) => Math.abs(item.currentStock - want) > 1e-9);

  const loanSums = new Map(
    (await LoanTxn.aggregate([{ $group: { _id: '$item', bal: { $sum: { $subtract: ['$inQty', '$outQty'] } } } }])).map((a) => [
      a._id.toString(),
      round3(a.bal),
    ]),
  );
  const loanStocks = await LoanStock.find().lean();
  const loanIds = new Set([...loanSums.keys(), ...loanStocks.map((s) => s.item.toString())]);
  const loanFixes = [...loanIds]
    .map((id) => ({ id, have: round3(loanStocks.find((s) => s.item.toString() === id)?.qty ?? 0), want: loanSums.get(id) || 0 }))
    .filter(({ have, want }) => Math.abs(have - want) > 1e-9);

  const negative = [];
  const days = await StockTxn.aggregate([
    { $group: { _id: { item: '$item', date: '$date' }, net: { $sum: { $subtract: ['$receiptQty', '$issueQty'] } } } },
    { $sort: { '_id.item': 1, '_id.date': 1 } },
  ]);
  const running = new Map();
  for (const d of days) {
    const key = d._id.item.toString();
    const bal = round3((running.get(key) || 0) + d.net);
    running.set(key, bal);
    if (bal < 0 && !negative.some((n) => n.key === key)) negative.push({ key, date: d._id.date.toISOString().slice(0, 10), bal });
  }

  console.log(`Items checked: ${items.length}`);
  console.log(`\nItem stock that does not match the Master Ledger: ${itemFixes.length}`);
  for (const f of itemFixes) console.log(`  ${f.item.code} ${f.item.name}: shows ${f.item.currentStock}, ledger says ${f.want}`);
  console.log(`\nLoan Store balances that do not match the Loan Store Ledger: ${loanFixes.length}`);
  for (const f of loanFixes) console.log(`  ${nameOf.get(f.id) || f.id}: shows ${f.have}, ledger says ${f.want}`);
  console.log(`\nItems whose Master Ledger goes below zero on a date (fix the voucher dates by hand): ${negative.length}`);
  for (const n of negative) console.log(`  ${nameOf.get(n.key) || n.key}: ${n.bal} on ${n.date}`);

  if (!itemFixes.length && !loanFixes.length) {
    console.log('\nCached balances are consistent. Nothing to repair.');
    return disconnectDb();
  }
  if (!apply) {
    console.log('\nDry run only. Pass --apply to repair the balances above.');
    return disconnectDb();
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.resolve(process.cwd(), '..', '.data', `reconcile-backup-${stamp}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ items: itemFixes.map((f) => f.item), loanStocks }, null, 2));
  console.log(`\nBackup written to ${file}`);

  await withTxn(async (session) => {
    for (const f of itemFixes) await Item.updateOne({ _id: f.item._id }, { $set: { currentStock: f.want } }, { session });
    for (const f of loanFixes) await LoanStock.updateOne({ item: f.id }, { $set: { qty: f.want } }, { upsert: true, session });
  });
  console.log('Balances repaired.');
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
