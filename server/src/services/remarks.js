import { Receipt, Issue, LoanVoucher } from '../models/Voucher.js';

/**
 * Remarks the user typed on vouchers, for ledger lines. Ledger transactions store a filled-in remark
 * (e.g. "Purchase (PO/1)" or "Issued to …") when none was typed; registers must show only what the user
 * entered: the line's own remark, else the voucher's Remarks box, else blank.
 *
 * `entries`: [{ model: 'RECEIPT' | 'ISSUE' | 'LOAN', voucherId, seq }] → Map "voucherId:seq" → remark.
 */
export async function userRemarks(entries) {
  const ids = (model) => [...new Set(entries.filter((e) => e.model === model && e.voucherId).map((e) => e.voucherId.toString()))];
  const [receipts, issues, loans] = await Promise.all([
    Receipt.find({ _id: { $in: ids('RECEIPT') } }, { remarks: 1 }).lean(),
    Issue.find({ _id: { $in: ids('ISSUE') } }, { remarks: 1, 'lines.remarks': 1 }).lean(),
    LoanVoucher.find({ _id: { $in: ids('LOAN') } }, { remarks: 1, 'lines.remarks': 1 }).lean(),
  ]);
  const byId = new Map([...receipts, ...issues, ...loans].map((v) => [v._id.toString(), v]));
  const out = new Map();
  for (const e of entries) {
    if (!e.voucherId) continue;
    const v = byId.get(e.voucherId.toString());
    if (!v) continue;
    out.set(`${e.voucherId}:${e.seq ?? 0}`, (v.lines?.[e.seq ?? 0]?.remarks || v.remarks || '').trim());
  }
  return out;
}

export const remarkKey = (voucherId, seq) => `${voucherId}:${seq ?? 0}`;
