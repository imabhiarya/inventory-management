import { LoanTxn, LoanStock } from '../models/Loan.js';
import { round3 } from '../utils/httpError.js';

// Posting to the separate Loan Store Ledger (LoanTxn rows + LoanStock balance per item).
// Used by the Loan Store vouchers and by Receipt / Issue vouchers for the Loan Store Ledger,
// so every Loan Store movement lands in one place and never touches normal stock.

/** Change an item's Loan Store balance. It may go below zero: any item can be issued on loan. */
export async function loanMove(item, qty, session) {
  const doc = await LoanStock.findOneAndUpdate({ item: item._id ?? item }, { $inc: { qty } }, { upsert: true, returnDocument: 'after', session });
  if (doc && doc.qty !== round3(doc.qty)) await LoanStock.updateOne({ _id: doc._id }, { $set: { qty: round3(doc.qty) } }, { session });
}

/** Record movements: each row is { item, inQty | outQty, ... }. Balances are updated to match. */
export async function postLoanRows(rows, session) {
  if (!rows.length) return;
  for (const r of rows) await loanMove(r.item, round3((r.inQty || 0) - (r.outQty || 0)), session);
  await LoanTxn.insertMany(rows, { session, ordered: true });
}

/** Undo everything a voucher posted to the Loan Store Ledger. Returns false if it posted nothing there. */
export async function reverseLoanRows(voucherId, session) {
  const rows = await LoanTxn.find({ voucherId }).session(session).lean();
  if (!rows.length) return false;
  for (const r of rows) await loanMove(r.item, round3((r.outQty || 0) - (r.inQty || 0)), session);
  await LoanTxn.deleteMany({ voucherId }, { session });
  return true;
}
