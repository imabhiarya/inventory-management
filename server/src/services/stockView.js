import Item from '../models/Item.js';
import { LoanStock } from '../models/Loan.js';
import { LOAN_LEDGER } from '../config/constants.js';
import { round3 } from '../utils/httpError.js';

// Loan Store Ledger items keep their balance in the separate Loan Store Ledger (LoanStock), not in
// Item.currentStock (which stays 0 for them). Everything that shows an item's balance goes through
// here so the Item Master, low-stock alerts and the dashboard agree with the Loan Store Ledger.

/** Same items (plain objects) with `currentStock` set to the Loan Store balance for Loan Store Ledger items. */
export async function withLoanBalances(items) {
  const loanIds = items.filter((i) => i.ledger === LOAN_LEDGER).map((i) => i._id);
  if (!loanIds.length) return items;
  const stocks = await LoanStock.find({ item: { $in: loanIds } }).lean();
  const qty = new Map(stocks.map((s) => [s.item.toString(), round3(s.qty)]));
  return items.map((i) => (i.ledger === LOAN_LEDGER ? { ...i, currentStock: qty.get(i._id.toString()) || 0 } : i));
}

export const isLowStock = (i) => i.status === 'ACTIVE' && i.currentStock <= i.minStock;

/** Active items at or below their re-order level (optionally one ledger), sorted by ledger then code. */
export async function lowStockItems({ ledger } = {}) {
  const normal =
    ledger === LOAN_LEDGER
      ? []
      : await Item.find({
          status: 'ACTIVE',
          ledger: ledger || { $ne: LOAN_LEDGER },
          $expr: { $lte: ['$currentStock', '$minStock'] },
        }).lean();
  const loan =
    !ledger || ledger === LOAN_LEDGER
      ? (await withLoanBalances(await Item.find({ status: 'ACTIVE', ledger: LOAN_LEDGER }).lean())).filter(isLowStock)
      : [];
  return [...normal, ...loan].sort((a, b) => a.ledger.localeCompare(b.ledger) || a.code.localeCompare(b.code));
}
