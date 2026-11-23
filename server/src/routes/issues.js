import { Router } from 'express';
import { z } from 'zod';
import { Issue } from '../models/Voucher.js';
import { nextSeq, audit, requireLedger, getSettings, isIndentLedger, INDENT_COUNTER, DEFAULT_INDENT_PREFIX } from '../models/misc.js';
import { canWrite, adminOnly } from '../middleware/auth.js';
import { validate, idParam, zId, zVoucherDay, zLedgerKey, zQty, zText, zReqText } from '../middleware/validate.js';
import {
  withTxn,
  loadItemsForLines,
  stockOut,
  reverseStockOut,
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

/** Loan Store Ledger issues have their own number series (Loan Issue No.). */
/** Number series: Loan Issue (LI-), Stock Indent for sub-ledgers (prefix set in Settings), else Issue (I-). */
async function numbering(ledger) {
  if (ledger === LOAN_LEDGER) return ['issue-loan', 'LI-'];
  if (await isIndentLedger(ledger)) return [INDENT_COUNTER, (await getSettings()).stockIndent?.prefix || DEFAULT_INDENT_PREFIX];
  return ['issue', 'I-'];
}
async function newNo(ledger, session) {
  const [key, prefix] = await numbering(ledger);
  return `${prefix}${pad6(await nextSeq(key, session))}`;
}

const router = Router();

const issueBody = z.object({
  date: zVoucherDay,
  issueType: zReqText('Issue type', 60),
  frequency: z.enum(['REGULAR', 'MONTHLY']).default('REGULAR'),
  civMonth: z.string().trim().optional().default(''),
  ledger: zLedgerKey,
  loanStoreType: zText(80).optional().default(''), // required for the Loan Store Ledger (checked below)
  oldIvNo: zText(40).optional().default(''),
  issueTo: zReqText('Issue to / Unit / Section', 160),
  authorityRef: zReqText('Issue authority / Ref.', 80),
  remarks: zText(300).optional().default(''),
  lines: z
    .array(
      z.object({
        item: zId,
        qty: zQty,
        ledgerPageNo: zReqText('Ledger page no.', 30),
        remarks: zText(200).optional().default(''),
      }),
    )
    .min(1, 'Add at least one item')
    .max(200),
})
  // A Monthly issue names the month it is certified for (not after the issue date's month); a Regular one has none.
  .superRefine((b, ctx) => {
    if (b.ledger === LOAN_LEDGER && !b.loanStoreType) ctx.addIssue({ code: 'custom', path: ['loanStoreType'], message: 'Select the Type of Loan Store' });
    if (b.frequency !== 'MONTHLY') return;
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(b.civMonth)) {
      ctx.addIssue({ code: 'custom', path: ['civMonth'], message: 'Select the month for the monthly issue voucher' });
    } else if (b.civMonth > b.date.toISOString().slice(0, 7)) {
      ctx.addIssue({ code: 'custom', path: ['civMonth'], message: 'The monthly issue month cannot be after the issue date' });
    }
  })
  .transform((b) => ({ ...b, civMonth: b.frequency === 'MONTHLY' ? b.civMonth : '', loanStoreType: b.ledger === LOAN_LEDGER ? b.loanStoreType : '' }));

router.get('/', validate(listQuery, 'query'), async (req, res) => {
  const q = req.valid.query;
  const filter = registerFilter(q, {
    typeField: 'issueType',
    typeValue: q.type,
    noField: 'issueNo',
    textFields: ['issueTo', 'authorityRef', 'oldIvNo'],
  });
  res.json(await paginate(Issue, filter, q));
});

router.get('/next-no', async (req, res) => {
  res.json({ next: await peekNextNo(...(await numbering(req.query.ledger))) });
});

router.get('/:id', validate(idParam, 'params'), async (req, res) => {
  const issue = await Issue.findById(req.valid.params.id)
    .populate('lines.item', 'code name uom ledger')
    .populate('createdBy cancelledBy', 'name username')
    .lean();
  if (!issue) throw notFound('Issue voucher not found');
  res.json({ issue });
});

/** Loan Store Ledger issue: comes out of the separate Loan Store Ledger, not normal stock. */
async function postLoan(issue, items, session) {
  issue.totalAmount = 0;
  const rows = issue.lines.map((line, i) => {
    line.qty = round3(line.qty);
    line.rate = 0;
    line.amount = 0;
    return {
      date: issue.date,
      item: line.item,
      type: 'ISSUE',
      voucherNo: issue.issueNo,
      voucherId: issue._id,
      party: issue.issueTo,
      outQty: line.qty,
      storeType: issue.loanStoreType || '',
      remarks: line.remarks || `${issue.issueType}${issue.oldIvNo ? ` (Old IV ${issue.oldIvNo})` : ''}`,
      seq: i,
    };
  });
  for (const line of issue.lines) rememberLedgerPage(items.get(line.item.toString()), line.ledgerPageNo);
  await postLoanRows(rows, session);
}

/** Remove the issued quantities from stock (valued at the weighted average rate). */
async function post(issue, session, items = new Map()) {
  // Every item must belong to the voucher's Type of Store / Ledger.
  await loadItemsForLines(issue.lines, session, { ledger: await requireLedger(issue.ledger), items });
  if (issue.ledger === LOAN_LEDGER) return postLoan(issue, items, session);
  const rows = [];
  let total = 0;
  for (const [i, line] of issue.lines.entries()) {
    const item = items.get(line.item.toString());
    line.qty = round3(line.qty);
    line.rate = item.avgRate;
    line.amount = round2(line.qty * line.rate);
    total += line.amount;
    rememberLedgerPage(item, line.ledgerPageNo);
    stockOut(item, line.qty);
    rows.push({
      date: issue.date,
      item: item._id,
      ledger: item.ledger,
      voucherType: 'ISSUE',
      voucherNo: issue.issueNo,
      oldIvNo: issue.oldIvNo || '',
      voucherId: issue._id,
      issueQty: line.qty,
      rate: line.rate,
      remarks: line.remarks || `Issued to ${issue.issueTo}`,
      seq: i,
    });
  }
  issue.totalAmount = round2(total);
  await writeTxns(rows, session);
}

/** Put the issued quantities back into stock (average rate unchanged). */
async function unpost(issue, session, items = new Map()) {
  if (await reverseLoanRows(issue._id, session)) return; // posted to the Loan Store Ledger
  await loadItemsForLines(issue.lines, session, { allowInactive: true, items });
  for (const line of issue.lines) reverseStockOut(items.get(line.item.toString()), line.qty);
  await deleteTxns(issue._id, session);
}

/** Save the changed items and make sure no balance goes below zero, now or on any earlier date. */
async function finish(items, session) {
  await saveItems(items, session);
  await assertHistoryNotNegative([...items.keys()], session);
}

router.post('/', canWrite, validate(issueBody), async (req, res) => {
  const issue = await withTxn(async (session) => {
    const doc = new Issue({
      ...req.valid.body,
      issueNo: await newNo(req.valid.body.ledger, session),
      fy: fyLabel(req.valid.body.date),
      createdBy: req.user._id,
    });
    const items = new Map();
    await post(doc, session, items);
    await finish(items, session);
    await doc.save({ session });
    await audit(req, 'CREATE', 'Issue', doc._id, `Issue ${doc.issueNo} to ${doc.issueTo}`, session);
    return doc;
  });
  res.status(201).json({ issue });
});

router.put('/:id', canWrite, validate(idParam, 'params'), validate(issueBody), async (req, res) => {
  const issue = await withTxn(async (session) => {
    const doc = await Issue.findById(req.valid.params.id).session(session);
    if (!doc) throw notFound('Issue voucher not found');
    if (doc.status !== 'POSTED') throw conflict('A cancelled issue cannot be edited');
    const items = new Map();
    await unpost(doc, session, items);
    doc.set({ ...req.valid.body, fy: fyLabel(req.valid.body.date), updatedBy: req.user._id });
    await post(doc, session, items);
    await finish(items, session);
    await doc.save({ session });
    await audit(req, 'UPDATE', 'Issue', doc._id, `Edited issue ${doc.issueNo}`, session);
    return doc;
  });
  res.json({ issue });
});

router.post('/:id/cancel', canWrite, validate(idParam, 'params'), validate(cancelBody), async (req, res) => {
  const issue = await withTxn(async (session) => {
    const doc = await Issue.findById(req.valid.params.id).session(session);
    if (!doc) throw notFound('Issue voucher not found');
    if (doc.status !== 'POSTED') throw badRequest('Issue is already cancelled');
    const items = new Map();
    await unpost(doc, session, items);
    await finish(items, session);
    doc.set({ status: 'CANCELLED', cancelledBy: req.user._id, cancelledAt: new Date(), cancelReason: req.valid.body.reason });
    await doc.save({ session });
    await audit(req, 'CANCEL', 'Issue', doc._id, `Cancelled issue ${doc.issueNo}: ${req.valid.body.reason}`, session);
    return doc;
  });
  res.json({ issue });
});

/** Permanently delete a cancelled issue (admin only). */
router.delete('/:id', adminOnly, validate(idParam, 'params'), async (req, res) => {
  const doc = await deleteCancelled(Issue, req.valid.params.id, { label: 'Issue', noField: 'issueNo' });
  await audit(req, 'DELETE', 'Issue', doc._id, `Deleted cancelled issue ${doc.issueNo} (cancelled: ${doc.cancelReason || '-'})`);
  res.json({ ok: true });
});

export default router;
