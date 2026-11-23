import Item from '../models/Item.js';
import StockTxn from '../models/StockTxn.js';
import { LoanTxn } from '../models/Loan.js';
import { Receipt } from '../models/Voucher.js';
import { LOAN_LEDGER } from '../config/constants.js';
import { round3 } from '../utils/httpError.js';

// Item life (age) for BER / Survey Off: how long the stock still held has been in the store,
// counted from the date of the Receipt Voucher (RV) that brought it in.
//
// Stock is used first-in-first-out, so what is still held is taken from the most recent receipts:
// e.g. 10 held from receipts of 8 (2015) and 6 (2021) → 6 from 2021 and 4 from 2015.

const DAY = 86400000;
export const LIFE_BANDS = [
  { key: 'lt5', label: 'Less than 5 years', min: 0, max: 5 },
  { key: '5to7', label: '5 to less than 7 years', min: 5, max: 7 },
  { key: '7to10', label: '7 to less than 10 years', min: 7, max: 10 },
  { key: '10to15', label: '10 to less than 15 years', min: 10, max: 15 },
  { key: '15plus', label: '15 years and above', min: 15, max: Infinity },
];

/** Whole years and months between two dates (calendar based). */
function ageParts(from, to) {
  let months = (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
  if (to.getUTCDate() < from.getUTCDate()) months -= 1;
  months = Math.max(0, months);
  return { years: Math.floor(months / 12), months: months % 12, totalMonths: months };
}

/**
 * Lots still held as on `asOn` for every item (optionally one ledger).
 * Normal ledgers use the stock ledger (receipts / opening, less issues); the Loan Store Ledger uses
 * its own ledger (receipts / store entries, less permanent issues and deposits — items only lent to
 * a section are still held).
 */
export async function itemLifeLots({ asOn, ledger, excludeLedgers = [] }) {
  const end = new Date(asOn.getTime() + DAY); // inclusive of the as-on day
  const ledgerFilter = ledger ? (excludeLedgers.includes(ledger) ? { $in: [] } : ledger) : { $nin: excludeLedgers };
  const items = await Item.find({ ledger: ledgerFilter }, 'code name uom ledger status').lean();
  const loanIds = items.filter((i) => i.ledger === LOAN_LEDGER).map((i) => i._id);
  const normalIds = items.filter((i) => i.ledger !== LOAN_LEDGER).map((i) => i._id);

  // movements: per item → { lots: [{date, voucherNo, voucherId, oldRvNo, qty, opening}], held }
  const per = new Map();
  const entry = (id) => {
    const k = id.toString();
    if (!per.has(k)) per.set(k, { lots: [], held: 0 });
    return per.get(k);
  };

  if (normalIds.length) {
    const txns = await StockTxn.find(
      { item: { $in: normalIds }, date: { $lt: end } },
      { item: 1, date: 1, voucherType: 1, voucherNo: 1, voucherId: 1, oldRvNo: 1, receiptQty: 1, issueQty: 1 },
    ).lean();
    for (const t of txns) {
      const e = entry(t.item);
      e.held += (t.receiptQty || 0) - (t.issueQty || 0);
      if (t.receiptQty > 0 && (t.voucherType === 'RECEIPT' || t.voucherType === 'OPENING')) {
        e.lots.push({ date: t.date, voucherNo: t.voucherNo, voucherId: t.voucherId, oldRvNo: t.oldRvNo || '', qty: t.receiptQty, opening: t.voucherType === 'OPENING' });
      }
    }
  }

  if (loanIds.length) {
    const txns = await LoanTxn.find({ item: { $in: loanIds }, date: { $lt: end } }).lean();
    for (const t of txns) {
      const e = entry(t.item);
      if (['OPENING', 'STORE_ENTRY', 'RECEIPT'].includes(t.type)) {
        e.held += t.inQty || 0;
        e.lots.push({ date: t.date, voucherNo: t.voucherNo, voucherId: t.voucherId, oldRvNo: '', qty: t.inQty, opening: t.type === 'OPENING' });
      } else if (t.type === 'ISSUE' || t.type === 'LOAN_DEPOSIT') {
        e.held -= t.outQty || 0;
      }
      // LOAN_ISSUE / LOAN_RETURN are temporary loans to sections: the item is still held.
    }
  }

  // Source / From and Old RV No. from the receipt vouchers.
  const rvIds = [...per.values()].flatMap((e) => e.lots.map((l) => l.voucherId)).filter(Boolean);
  const rvs = await Receipt.find({ _id: { $in: rvIds } }, { source: 1, oldRvNo: 1, receiptType: 1 }).lean();
  const rvById = new Map(rvs.map((r) => [r._id.toString(), r]));

  const rows = [];
  for (const item of items) {
    const e = per.get(item._id.toString());
    if (!e) continue;
    let left = round3(e.held);
    if (left <= 0) continue;
    // Newest first: what is still held came in most recently.
    const lots = e.lots.sort((a, b) => b.date - a.date);
    for (const lot of lots) {
      if (left <= 0) break;
      const take = round3(Math.min(lot.qty, left));
      left = round3(left - take);
      const rv = lot.voucherId ? rvById.get(lot.voucherId.toString()) : null;
      const age = ageParts(new Date(lot.date), asOn);
      rows.push({
        item,
        ledger: item.ledger,
        rvNo: lot.opening ? 'Opening' : lot.voucherNo,
        oldRvNo: rv?.oldRvNo || lot.oldRvNo || '',
        rvDate: lot.date,
        source: rv?.source || '',
        receivedQty: round3(lot.qty),
        heldQty: take,
        ageYears: age.years,
        ageMonths: age.months,
        ageValue: age.totalMonths / 12,
      });
    }
    // Held stock with no receipt on record (should not normally happen).
    if (left > 0) rows.push({ item, ledger: item.ledger, rvNo: '—', oldRvNo: '', rvDate: null, source: '', receivedQty: 0, heldQty: left, ageYears: null, ageMonths: null, ageValue: null });
  }
  // Ledger-wise, oldest first within each ledger.
  return rows.sort((a, b) => a.ledger.localeCompare(b.ledger) || (b.ageValue ?? -1) - (a.ageValue ?? -1) || a.item.code.localeCompare(b.item.code));
}

/** Count of lots, quantity held and the item names in each life band. */
export function lifeBands(rows) {
  const bands = LIFE_BANDS.map((b) => ({ ...b, lots: 0, qty: 0, items: new Set(), max: Number.isFinite(b.max) ? b.max : null }));
  const unknown = { key: 'unknown', label: 'RV date not on record', lots: 0, qty: 0, items: new Set() };
  for (const r of rows) {
    const band = r.ageValue == null ? unknown : bands.find((b) => r.ageValue >= b.min && (b.max == null || r.ageValue < b.max));
    band.lots += 1;
    band.qty = round3(band.qty + r.heldQty);
    band.items.add(`${r.item.name} (${r.item.code})`);
  }
  return (unknown.lots ? [...bands, unknown] : bands).map((b) => ({ ...b, items: [...b.items] }));
}
