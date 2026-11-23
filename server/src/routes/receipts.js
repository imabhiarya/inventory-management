import { Router } from 'express';
import { z } from 'zod';
import { Receipt } from '../models/Voucher.js';
import { nextSeq, audit, requireLedger } from '../models/misc.js';
import { canWrite, adminOnly } from '../middleware/auth.js';
import { validate, idParam, zId, zVoucherDay, zLedgerKey, zQty, zMoney, zText, zReqText } from '../middleware/validate.js';
import {
  withTxn,
  loadItemsForLines,
  stockIn,
  reverseStockIn,
  writeTxns,
  deleteTxns,
  rememberLedgerPage,
  saveItems,
  assertHistoryNotNegative,
} from '../services/stock.js';
import { listQuery, registerFilter, paginate, peekNextNo, pad6, cancelBody, deleteCancelled } from '../services/vouchers.js';
import { badRequest, conflict, notFound, round2, round3 } from '../utils/httpError.js';
import { fyLabel } from '../utils/dates.js';
import { LOAN_LEDGER } from '../config/constants.js';
import { postLoanRows, reverseLoanRows } from '../services/loanLedger.js';

/** B/F (brought forward from the old manual ledger) receipt: no PO / sanction, an Old Ledger Page instead of an Old RV No. */
const isBroughtForward = (receiptType) => (receiptType || '').replace(/[^a-z]/gi, '').toUpperCase() === 'BF';

const router = Router();

const receiptBody = z.object({
  date: zVoucherDay,
  receiptType: zReqText('Receipt type', 60),
  ledger: zLedgerKey,
  loanStoreType: zText(80).optional().default(''), // required for the Loan Store Ledger (checked below)
  oldRvNo: zText(40).optional().default(''),
  oldLedgerPage: zText(40).optional().default(''),
  source: zReqText('Source / From', 160),
  // Not used for the Loan Store Ledger; required for every other ledger (checked below).
  poNo: zText(80).optional().default(''),
  poDate: zVoucherDay.optional(),
  remarks: zText(300).optional().default(''),
  lines: z
    .array(
      z.object({
        item: zId,
        codeHead: zText(20).optional().default(''),
        qty: zQty,
        rate: zMoney.default(0),
        ledgerPageNo: zText(30).optional().default(''),
      }),
    )
    .min(1, 'Add at least one item')
    .max(200),
})
  .superRefine((b, ctx) => {
    if (b.ledger === LOAN_LEDGER && !b.loanStoreType) ctx.addIssue({ code: 'custom', path: ['loanStoreType'], message: 'Select the Type of Loan Store' });
    if (b.ledger === LOAN_LEDGER || isBroughtForward(b.receiptType)) return;
    if (!b.poNo) ctx.addIssue({ code: 'custom', path: ['poNo'], message: 'PO / Sanction No. is required' });
    if (!b.poDate) ctx.addIssue({ code: 'custom', path: ['poDate'], message: 'PO / Sanction date is required' });
    else if (b.poDate > b.date) ctx.addIssue({ code: 'custom', path: ['poDate'], message: 'PO / Sanction date cannot be after the receipt date' });
  })
  // B/F receipts have no PO / sanction and no Old RV No.; other receipts have no Old Ledger Page.
  .transform((b) => (isBroughtForward(b.receiptType) ? { ...b, poNo: '', poDate: undefined, oldRvNo: '' } : { ...b, oldLedgerPage: '' }))
  // Loan Store Ledger receipts have no PO / sanction, code head or rate.
  .transform((b) =>
    b.ledger === LOAN_LEDGER
      ? { ...b, poNo: '', poDate: undefined, lines: b.lines.map((l) => ({ ...l, codeHead: '', rate: 0 })) }
      : { ...b, loanStoreType: '' },
  );

/** Ledger remarks for a receipt: its type plus the PO, Old RV No. or Old Ledger Page reference. */
const receiptRemarks = (r) => {
  if (isBroughtForward(r.receiptType)) return `${r.receiptType}${r.oldLedgerPage ? ` (Old Ledger Pg ${r.oldLedgerPage})` : ''}`;
  if (r.ledger === LOAN_LEDGER) return `${r.receiptType}${r.oldRvNo ? ` (Old RV ${r.oldRvNo})` : ''}`;
  return `${r.receiptType} (${r.poNo})`;
};

/** Loan Store Ledger receipts have their own number series (Loan Receipt No.). */
const numbering = (ledger) => (ledger === LOAN_LEDGER ? ['receipt-loan', 'LR-'] : ['receipt', 'R-']);
async function newNo(ledger, session) {
  const [key, prefix] = numbering(ledger);
  return `${prefix}${pad6(await nextSeq(key, session))}`;
}

router.get('/', validate(listQuery, 'query'), async (req, res) => {
  const q = req.valid.query;
  const filter = registerFilter(q, {
    typeField: 'receiptType',
    typeValue: q.type,
    noField: 'receiptNo',
    textFields: ['source', 'poNo', 'oldRvNo', 'oldLedgerPage'],
  });
  res.json(await paginate(Receipt, filter, q));
});

router.get('/next-no', async (req, res) => {
  res.json({ next: await peekNextNo(...numbering(req.query.ledger)) });
});

router.get('/:id', validate(idParam, 'params'), async (req, res) => {
  const receipt = await Receipt.findById(req.valid.params.id)
    .populate('lines.item', 'code name uom ledger')
    .populate('createdBy cancelledBy', 'name username')
    .lean();
  if (!receipt) throw notFound('Receipt not found');
  res.json({ receipt });
});

/** Loan Store Ledger receipt: goes into the separate Loan Store Ledger, not normal stock. */
async function postLoan(receipt, items, session) {
  receipt.totalAmount = 0;
  const rows = receipt.lines.map((line, i) => {
    line.qty = round3(line.qty);
    line.rate = 0;
    line.amount = 0;
    return {
      date: receipt.date,
      item: line.item,
      type: 'RECEIPT',
      voucherNo: receipt.receiptNo,
      voucherId: receipt._id,
      party: receipt.source,
      inQty: line.qty,
      storeType: receipt.loanStoreType || '',
      remarks: receiptRemarks(receipt),
      seq: i,
    };
  });
  for (const line of receipt.lines) rememberLedgerPage(items.get(line.item.toString()), line.ledgerPageNo);
  await postLoanRows(rows, session);
}

/** Add the receipt's quantities to stock and write ledger rows. `items` caches the Item documents (saved by finish()). */
async function post(receipt, session, items = new Map()) {
  // Every item must belong to the voucher's Type of Store / Ledger.
  await loadItemsForLines(receipt.lines, session, { ledger: await requireLedger(receipt.ledger), items });
  if (receipt.ledger === LOAN_LEDGER) return postLoan(receipt, items, session);
  const rows = [];
  let total = 0;
  receipt.lines.forEach((line, i) => {
    line.qty = round3(line.qty);
    line.amount = round2(line.qty * line.rate);
    total += line.amount;
    const item = items.get(line.item.toString());
    rememberLedgerPage(item, line.ledgerPageNo);
    rows.push({
      date: receipt.date,
      item: item._id,
      ledger: item.ledger,
      voucherType: 'RECEIPT',
      voucherNo: receipt.receiptNo,
      oldRvNo: receipt.oldRvNo || '',
      voucherId: receipt._id,
      receiptQty: line.qty,
      rate: line.rate,
      remarks: receiptRemarks(receipt),
      seq: i,
    });
  });
  for (const line of receipt.lines) stockIn(items.get(line.item.toString()), line.qty, line.rate);
  receipt.totalAmount = round2(total);
  await writeTxns(rows, session);
}

/** Take the receipt's quantities back out of stock and remove its ledger rows. */
async function unpost(receipt, session, items = new Map()) {
  if (await reverseLoanRows(receipt._id, session)) return; // posted to the Loan Store Ledger
  await loadItemsForLines(receipt.lines, session, { allowInactive: true, items });
  for (const line of receipt.lines) reverseStockIn(items.get(line.item.toString()), line.qty, line.rate);
  await deleteTxns(receipt._id, session);
}

/** Save the changed items and make sure no balance goes below zero, now or on any earlier date. */
async function finish(items, session) {
  await saveItems(items, session);
  await assertHistoryNotNegative([...items.keys()], session);
}

router.post('/', canWrite, validate(receiptBody), async (req, res) => {
  const receipt = await withTxn(async (session) => {
    const doc = new Receipt({
      ...req.valid.body,
      receiptNo: await newNo(req.valid.body.ledger, session),
      fy: fyLabel(req.valid.body.date),
      createdBy: req.user._id,
    });
    const items = new Map();
    await post(doc, session, items);
    await finish(items, session);
    await doc.save({ session });
    await audit(req, 'CREATE', 'Receipt', doc._id, `Receipt ${doc.receiptNo} ₹${doc.totalAmount}`, session);
    return doc;
  });
  res.status(201).json({ receipt });
});

router.put('/:id', canWrite, validate(idParam, 'params'), validate(receiptBody), async (req, res) => {
  const receipt = await withTxn(async (session) => {
    const doc = await Receipt.findById(req.valid.params.id).session(session);
    if (!doc) throw notFound('Receipt not found');
    if (doc.status !== 'POSTED') throw conflict('A cancelled receipt cannot be edited');
    const items = new Map();
    await unpost(doc, session, items);
    doc.set({ ...req.valid.body, fy: fyLabel(req.valid.body.date), updatedBy: req.user._id });
    await post(doc, session, items);
    await finish(items, session);
    await doc.save({ session });
    await audit(req, 'UPDATE', 'Receipt', doc._id, `Edited receipt ${doc.receiptNo}`, session);
    return doc;
  });
  res.json({ receipt });
});

router.post('/:id/cancel', canWrite, validate(idParam, 'params'), validate(cancelBody), async (req, res) => {
  const receipt = await withTxn(async (session) => {
    const doc = await Receipt.findById(req.valid.params.id).session(session);
    if (!doc) throw notFound('Receipt not found');
    if (doc.status !== 'POSTED') throw badRequest('Receipt is already cancelled');
    const items = new Map();
    await unpost(doc, session, items);
    await finish(items, session);
    doc.set({ status: 'CANCELLED', cancelledBy: req.user._id, cancelledAt: new Date(), cancelReason: req.valid.body.reason });
    await doc.save({ session });
    await audit(req, 'CANCEL', 'Receipt', doc._id, `Cancelled receipt ${doc.receiptNo}: ${req.valid.body.reason}`, session);
    return doc;
  });
  res.json({ receipt });
});

/** Permanently delete a cancelled receipt (admin only). */
router.delete('/:id', adminOnly, validate(idParam, 'params'), async (req, res) => {
  const doc = await deleteCancelled(Receipt, req.valid.params.id, { label: 'Receipt', noField: 'receiptNo' });
  await audit(req, 'DELETE', 'Receipt', doc._id, `Deleted cancelled receipt ${doc.receiptNo} (cancelled: ${doc.cancelReason || '-'})`);
  res.json({ ok: true });
});

export default router;
