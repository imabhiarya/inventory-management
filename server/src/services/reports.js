import Item from '../models/Item.js';
import StockTxn from '../models/StockTxn.js';
import { LoanTxn } from '../models/Loan.js';
import { LOAN_LEDGER } from '../config/constants.js';
import { round2, round3 } from '../utils/httpError.js';

/**
 * Opening / receipt / issue / closing per item for a period.
 * "Opening" = everything before `from`, plus brought-forward opening balances entered at item registration.
 */
export async function periodBalance({ from, to, ledger }) {
  const match = { date: { $lte: to } };
  if (ledger) match.ledger = ledger;
  const isOpening = { $or: [{ $lt: ['$date', from] }, { $eq: ['$voucherType', 'OPENING'] }] };
  const agg = await StockTxn.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$item',
        opening: { $sum: { $cond: [isOpening, { $subtract: ['$receiptQty', '$issueQty'] }, 0] } },
        receipt: { $sum: { $cond: [isOpening, 0, '$receiptQty'] } },
        issue: { $sum: { $cond: [isOpening, 0, '$issueQty'] } },
      },
    },
  ]);
  const byItem = new Map(agg.map((a) => [a._id.toString(), a]));
  // Loan Store Ledger items move in the separate Loan Store Ledger (LoanTxn), not StockTxn.
  const loanByItem = new Map();
  if (!ledger || ledger === LOAN_LEDGER) {
    const isLoanOpening = { $or: [{ $lt: ['$date', from] }, { $eq: ['$type', 'OPENING'] }] };
    const loanAgg = await LoanTxn.aggregate([
      { $match: { date: { $lte: to } } },
      {
        $group: {
          _id: '$item',
          opening: { $sum: { $cond: [isLoanOpening, { $subtract: ['$inQty', '$outQty'] }, 0] } },
          receipt: { $sum: { $cond: [isLoanOpening, 0, '$inQty'] } },
          issue: { $sum: { $cond: [isLoanOpening, 0, '$outQty'] } },
        },
      },
    ]);
    for (const a of loanAgg) loanByItem.set(a._id.toString(), a);
  }
  const items = await Item.find(ledger ? { ledger } : {})
    .sort({ ledger: 1, code: 1 })
    .lean();

  const rows = items.map((it) => {
    const source = it.ledger === LOAN_LEDGER ? loanByItem : byItem;
    const a = source.get(it._id.toString()) || { opening: 0, receipt: 0, issue: 0 };
    const opening = round3(a.opening);
    const receipt = round3(a.receipt);
    const issue = round3(a.issue);
    const closing = round3(opening + receipt - issue);
    return {
      item: it._id,
      code: it.code,
      name: it.name,
      description: it.description,
      ledger: it.ledger,
      uom: it.uom,
      minStock: it.minStock,
      status: it.status,
      avgRate: it.avgRate,
      opening,
      receipt,
      issue,
      closing,
      value: round2(closing * it.avgRate),
    };
  });
  return rows;
}

export function summariseByLedger(rows, ledgers) {
  // Include any ledger key found in the data even if it was since removed from settings.
  const all = [...ledgers];
  for (const r of rows) if (!all.some((l) => l.key === r.ledger)) all.push({ key: r.ledger, label: r.ledger });
  const summary = all.map((l) => ({
    ledger: l.key,
    label: l.label,
    items: 0,
    opening: 0,
    receipt: 0,
    issue: 0,
    closing: 0,
    value: 0,
  }));
  const idx = Object.fromEntries(summary.map((s, i) => [s.ledger, i]));
  for (const r of rows) {
    const s = summary[idx[r.ledger]];
    s.items += 1;
    s.opening += r.opening;
    s.receipt += r.receipt;
    s.issue += r.issue;
    s.closing += r.closing;
    s.value += r.value;
  }
  for (const s of summary) {
    for (const k of ['opening', 'receipt', 'issue', 'closing']) s[k] = round3(s[k]);
    s.value = round2(s.value);
  }
  const total = summary.reduce(
    (t, s) => {
      for (const k of ['items', 'opening', 'receipt', 'issue', 'closing', 'value']) t[k] += s[k];
      return t;
    },
    { items: 0, opening: 0, receipt: 0, issue: 0, closing: 0, value: 0 },
  );
  for (const k of ['opening', 'receipt', 'issue', 'closing']) total[k] = round3(total[k]);
  total.value = round2(total.value);
  return { summary, total };
}
