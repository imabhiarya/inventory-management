import { Router } from 'express';
import { z } from 'zod';
import { LoanVoucher } from '../models/Voucher.js';
import { LoanTxn, LoanStock, LOAN_TXN_TYPES } from '../models/Loan.js';
import Item from '../models/Item.js';
import { nextSeq, audit } from '../models/misc.js';
import { canWrite, adminOnly } from '../middleware/auth.js';
import { validate, idParam, zId, zDay, zVoucherDay, zQty, zText, zReqText } from '../middleware/validate.js';
import { withTxn, loadItemsForLines } from '../services/stock.js';
import { loanMove, reverseLoanRows } from '../services/loanLedger.js';
import { listQuery, registerFilter, paginate, peekNextNo, pad6, cancelBody, deleteCancelled } from '../services/vouchers.js';
import { badRequest, notFound, round3, conflict, escapeRegex } from '../utils/httpError.js';
import { fyLabel, today } from '../utils/dates.js';
import { LOAN_LEDGER } from '../config/constants.js';
import { userRemarks, remarkKey } from '../services/remarks.js';

// Loan Store: items received from other units (Store Entry), issued to sections on a temporary
// basis (Loan Issue) and returned by them (Loan Receipt). It has its own ledger (LoanTxn /
// LoanStock) and never changes an item's normal ledger stock, so items from any ledger can be used.

const router = Router();

const line = z.object({ item: zId, qty: zQty, remarks: zText(200).optional().default('') });
const lines = (msg) =>
  z
    .array(line)
    .min(1, msg)
    .max(200)
    .refine((a) => new Set(a.map((l) => l.item)).size === a.length, 'Each item can appear only once on a loan voucher (combine the quantities)');

const entryBody = z.object({
  date: zVoucherDay,
  issueTo: zReqText('Received from (other unit)', 160), // the lending unit / office
  storeType: zText(120).optional().default(''),
  reference: zText(80).optional().default(''),
  remarks: zText(300).optional().default(''),
  lines: lines('Add at least one item'),
});

const issueBody = z
  .object({
    date: zVoucherDay,
    issueTo: zReqText('Issue to (section)', 160),
    qtrNo: zText(40).optional().default(''),
    loanType: zText(60).optional().default('Loan Issue'),
    reference: zText(80).optional().default(''),
    returnDueDate: zDay.optional(),
    remarks: zText(300).optional().default(''),
    lines: lines('Add at least one item'),
  })
  .refine((b) => !b.returnDueDate || b.returnDueDate >= b.date, { message: 'Return due date cannot be before the voucher date', path: ['returnDueDate'] });

// A return names the section; it is set against that section's oldest outstanding loan issues.
const receiptBody = z.object({
  date: zVoucherDay,
  issueTo: zReqText('Returned by (section)', 160),
  qtrNo: zText(40).optional().default(''),
  remarks: zText(300).optional().default(''),
  lines: lines('Enter at least one returned item'),
});

// Loan From Other Sources: items received from another office and handed straight to a section.
const otherSourceBody = z.object({
  date: zVoucherDay,
  issueTo: zReqText('Received from (other office)', 160),
  section: zReqText('Issue to (section)', 160),
  qtrNo: zText(40).optional().default(''),
  reference: zText(80).optional().default(''),
  remarks: zText(300).optional().default(''),
  lines: lines('Add at least one item'),
});

// Loan Deposit: items given back to the office they were taken on loan from.
const depositBody = z.object({
  date: zVoucherDay,
  issueTo: zReqText('Deposited to (other office)', 160),
  reference: zText(80).optional().default(''),
  remarks: zText(300).optional().default(''),
  lines: lines('Add at least one item'),
});

const loanListQuery = listQuery.extend({
  kind: z.enum(['ISSUE', 'RECEIPT', 'BORROW', 'DEPOSIT', '']).optional(),
  issueTo: zText(160).optional(),
});

const SEQ = {
  ISSUE: ['loan-issue', 'LN-I-'],
  RECEIPT: ['loan-receipt', 'LN-R-'],
  BORROW: ['loan-borrow', 'LN-O-'],
  DEPOSIT: ['loan-deposit', 'LN-D-'],
};

// ---------- Loan Store balance helpers ----------

const loanIn = (item, qty, session) => loanMove(item, qty, session);
const loanOut = (item, qty, session) => loanMove(item, -qty, session);

const returnStatus = (loan) => {
  const any = loan.lines.some((x) => x.returnedQty > 0);
  const all = loan.lines.every((x) => x.returnedQty >= x.qty);
  return all ? 'RETURNED' : any ? 'PARTIAL' : 'ISSUED';
};

const TXN = {
  BORROW: { type: 'STORE_ENTRY', in: true, note: (d) => `Received from ${d.issueTo}` },
  ISSUE: { type: 'LOAN_ISSUE', in: false, note: (d) => `Issued to ${d.issueTo}${d.qtrNo ? `, Qtr No ${d.qtrNo}` : ''}` },
  RECEIPT: { type: 'LOAN_RETURN', in: true, note: (d) => `Returned by ${d.issueTo}` },
  DEPOSIT: { type: 'LOAN_DEPOSIT', in: false, note: (d) => `Deposited to ${d.issueTo}` },
};

async function writeLoanTxns(doc, session) {
  const t = TXN[doc.kind];
  const rows = doc.lines.map((l, i) => ({
    date: doc.date,
    item: l.item,
    type: t.type,
    voucherNo: doc.voucherNo,
    voucherId: doc._id,
    party: doc.issueTo,
    inQty: t.in ? l.qty : 0,
    outQty: t.in ? 0 : l.qty,
    remarks: l.remarks || t.note(doc),
    seq: i,
  }));
  await LoanTxn.insertMany(rows, { session, ordered: true });
}

// ---------- Read ----------

router.get('/', validate(loanListQuery, 'query'), async (req, res) => {
  const q = req.valid.query;
  const filter = registerFilter(q, { noField: 'voucherNo', textFields: ['issueTo', 'reference', 'remarks', 'qtrNo', 'storeType'] });
  if (q.kind) filter.kind = q.kind;
  if (q.issueTo) filter.issueTo = q.issueTo;
  res.json(await paginate(LoanVoucher, filter, q));
});

router.get('/next-no', validate(z.object({ kind: z.enum(['ISSUE', 'RECEIPT', 'BORROW', 'DEPOSIT']) }), 'query'), async (req, res) => {
  res.json({ next: await peekNextNo(...SEQ[req.valid.query.kind]) });
});

/**
 * Items still out, with the outstanding quantity per line:
 * kind=ISSUE (default) – loan issues not yet returned by sections;
 * kind=BORROW – loans taken from other offices not yet deposited back.
 */
router.get('/outstanding', validate(z.object({ kind: z.enum(['ISSUE', 'BORROW']).default('ISSUE') }), 'query'), async (req, res) => {
  const { kind } = req.valid.query;
  const filter = kind === 'ISSUE' ? { returnStatus: { $in: ['ISSUED', 'PARTIAL'] } } : { returnStatus: { $ne: 'RETURNED' } };
  const rows = await LoanVoucher.find({ kind, status: 'POSTED', ...filter })
    .sort(kind === 'ISSUE' ? { returnDueDate: 1 } : { date: 1 })
    .populate('lines.item', 'code name uom')
    .lean();
  const t = today();
  res.json({
    rows: rows.map((r) => ({
      ...r,
      overdue: r.returnDueDate && r.returnDueDate < t,
      lines: r.lines.map((l) => ({ ...l, outstanding: round3(l.qty - l.returnedQty) })),
    })),
  });
});

/** Current Loan Store balance per item (only items that have been in the Loan Store). */
router.get('/stock', async (req, res) => {
  const rows = await LoanStock.find().lean();
  res.json({ stock: Object.fromEntries(rows.map((r) => [r.item.toString(), round3(r.qty)])) });
});

const ledgerQuery = z.object({
  from: zDay,
  to: zDay,
  item: zId.optional().or(z.literal('').transform(() => undefined)),
  // Type of Loan Store (Furniture Store, T&P Store …): only movements recorded under that type.
  storeType: zText(80).optional().or(z.literal('').transform(() => undefined)),
});

/**
 * Loan Store Ledger.
 * With `item`: that item's movements in the period with a running balance.
 * Without: one summary row per item (opening, received, issued, returned, closing, out with sections).
 */
router.get('/ledger', validate(ledgerQuery, 'query'), async (req, res) => {
  const { from, to, item: itemId, storeType } = req.valid.query;
  const typeMatch = storeType ? { storeType } : {};
  const end = new Date(to.getTime() + 86400000); // inclusive of the "to" day

  if (itemId) {
    const item = await Item.findById(itemId, 'code name uom ledger').lean();
    if (!item) throw notFound('Item not found');
    const txns = await LoanTxn.find({ item: item._id, date: { $lt: end }, ...typeMatch }).sort({ date: 1, createdAt: 1, seq: 1 }).lean();
    let bal = 0;
    const rows = [];
    for (const t of txns) {
      if (t.date < from) {
        bal = round3(bal + t.inQty - t.outQty);
        continue;
      }
      if (!rows.length) rows.push({ opening: true, balance: bal });
      bal = round3(bal + t.inQty - t.outQty);
      rows.push({ ...t, typeLabel: LOAN_TXN_TYPES[t.type], balance: bal });
    }
    if (!rows.length) rows.push({ opening: true, balance: bal });
    // Remarks: only what the user typed on the voucher (never the auto-filled text), else blank.
    const model = (type) => (type === 'RECEIPT' ? 'RECEIPT' : type === 'ISSUE' ? 'ISSUE' : type === 'OPENING' ? null : 'LOAN');
    const typed = await userRemarks(rows.filter((r) => !r.opening && model(r.type)).map((r) => ({ model: model(r.type), voucherId: r.voucherId, seq: r.seq })));
    for (const r of rows) if (!r.opening) r.remarks = model(r.type) ? typed.get(remarkKey(r.voucherId, r.seq)) || '' : '';
    return res.json({ item, rows, closing: bal });
  }

  const agg = await LoanTxn.aggregate([
    { $match: { date: { $lt: end }, ...typeMatch } },
    {
      $group: {
        _id: '$item',
        storeTypes: { $addToSet: '$storeType' },
        closing: { $sum: { $subtract: ['$inQty', '$outQty'] } },
        before: { $sum: { $cond: [{ $lt: ['$date', from] }, { $subtract: ['$inQty', '$outQty'] }, 0] } },
        received: { $sum: { $cond: [{ $and: [{ $gte: ['$date', from] }, { $in: ['$type', ['STORE_ENTRY', 'OPENING', 'RECEIPT']] }] }, '$inQty', 0] } },
        issued: { $sum: { $cond: [{ $and: [{ $gte: ['$date', from] }, { $in: ['$type', ['LOAN_ISSUE', 'ISSUE']] }] }, '$outQty', 0] } },
        returned: { $sum: { $cond: [{ $and: [{ $gte: ['$date', from] }, { $eq: ['$type', 'LOAN_RETURN'] }] }, '$inQty', 0] } },
        deposited: { $sum: { $cond: [{ $and: [{ $gte: ['$date', from] }, { $eq: ['$type', 'LOAN_DEPOSIT'] }] }, '$outQty', 0] } },
      },
    },
  ]);
  const out = await LoanVoucher.aggregate([
    { $match: { kind: 'ISSUE', status: 'POSTED', returnStatus: { $in: ['ISSUED', 'PARTIAL'] } } },
    { $unwind: '$lines' },
    { $group: { _id: '$lines.item', qty: { $sum: { $subtract: ['$lines.qty', '$lines.returnedQty'] } } } },
  ]);
  const outBy = new Map(out.map((o) => [o._id.toString(), o.qty]));
  // Every item registered in the Loan Store Ledger (even with no movement yet), plus any other item with loan movements.
  // With a Type of Loan Store chosen, only items that have movements of that type.
  const items = await Item.find(
    storeType ? { _id: { $in: agg.map((a) => a._id) } } : { $or: [{ ledger: LOAN_LEDGER }, { _id: { $in: agg.map((a) => a._id) } }] },
    'code name uom ledger',
  ).lean();
  const byId = new Map(items.map((i) => [i._id.toString(), i]));
  const moved = new Set(agg.map((a) => a._id.toString()));
  const none = { before: 0, received: 0, issued: 0, returned: 0, deposited: 0, closing: 0 };
  const all = [...agg, ...items.filter((i) => !moved.has(i._id.toString())).map((i) => ({ _id: i._id, ...none }))];
  const rows = all
    .map((a) => ({
      item: byId.get(a._id.toString()),
      storeTypes: (a.storeTypes || []).filter(Boolean),
      opening: round3(a.before),
      received: round3(a.received),
      issued: round3(a.issued),
      returned: round3(a.returned),
      deposited: round3(a.deposited),
      closing: round3(a.closing),
      withSections: round3(outBy.get(a._id.toString()) || 0),
    }))
    .filter((r) => r.item)
    .sort((a, b) => a.item.name.localeCompare(b.item.name));
  res.json({ rows });
});

router.get('/:id', validate(idParam, 'params'), async (req, res) => {
  const voucher = await LoanVoucher.findById(req.valid.params.id)
    .populate('lines.item', 'code name uom ledger')
    .populate('againstIssue', 'voucherNo date')
    .populate('linkedVoucher', 'voucherNo kind issueTo')
    .populate('createdBy cancelledBy', 'name username')
    .lean();
  if (!voucher) throw notFound('Loan voucher not found');
  res.json({ voucher });
});

// ---------- Write ----------

/** Store Entry: items received on loan from another unit into the Loan Store. */
router.post(['/entry', '/borrow'], canWrite, validate(entryBody), async (req, res) => {
  const voucher = await withTxn(async (session) => {
    const body = req.valid.body;
    const items = await loadItemsForLines(body.lines, session);
    const doc = new LoanVoucher({
      ...body,
      kind: 'BORROW',
      loanLedger: true,
      voucherNo: `LN-O-${pad6(await nextSeq('loan-borrow', session))}`,
      fy: fyLabel(body.date),
      createdBy: req.user._id,
    });
    for (const l of doc.lines) {
      l.qty = round3(l.qty);
      await loanIn(items.get(l.item.toString()), l.qty, session);
    }
    await writeLoanTxns(doc, session);
    await doc.save({ session });
    await audit(req, 'CREATE', 'LoanVoucher', doc._id, `Loan store entry ${doc.voucherNo} from ${doc.issueTo}`, session);
    return doc;
  });
  res.status(201).json({ voucher });
});

/** Loan Issue: items issued from the Loan Store to a section on a temporary basis. */
router.post('/issue', canWrite, validate(issueBody), async (req, res) => {
  const voucher = await withTxn(async (session) => {
    const body = req.valid.body;
    const items = await loadItemsForLines(body.lines, session);
    const doc = new LoanVoucher({
      ...body,
      kind: 'ISSUE',
      loanLedger: true,
      voucherNo: `LN-I-${pad6(await nextSeq('loan-issue', session))}`,
      returnStatus: 'ISSUED',
      fy: fyLabel(body.date),
      createdBy: req.user._id,
    });
    for (const l of doc.lines) {
      l.qty = round3(l.qty);
      await loanOut(items.get(l.item.toString()), l.qty, session);
    }
    await writeLoanTxns(doc, session);
    await doc.save({ session });
    await audit(req, 'CREATE', 'LoanVoucher', doc._id, `Loan issue ${doc.voucherNo} to ${doc.issueTo}`, session);
    return doc;
  });
  res.status(201).json({ voucher });
});

/**
 * Loan From Other Sources: one entry saves two linked vouchers –
 *   a loan receipt (LN-O-…) for the office the items came from, and
 *   a loan issue (LN-I-…) to the section they are handed to (returnable later on the Receipt tab).
 * Both post to the Loan Store Ledger; the balance goes up and straight back down.
 */
router.post('/other-source', canWrite, validate(otherSourceBody), async (req, res) => {
  const result = await withTxn(async (session) => {
    const body = req.valid.body;
    const items = await loadItemsForLines(body.lines, session);
    const copyLines = () => body.lines.map((l) => ({ item: l.item, qty: round3(l.qty), remarks: l.remarks }));
    const common = { date: body.date, remarks: body.remarks, loanLedger: true, fy: fyLabel(body.date), createdBy: req.user._id };
    const receipt = new LoanVoucher({
      ...common,
      kind: 'BORROW',
      issueTo: body.issueTo,
      reference: body.reference,
      lines: copyLines(),
      voucherNo: `LN-O-${pad6(await nextSeq('loan-borrow', session))}`,
    });
    const issue = new LoanVoucher({
      ...common,
      kind: 'ISSUE',
      issueTo: body.section,
      qtrNo: body.qtrNo,
      reference: body.reference,
      lines: copyLines(),
      returnStatus: 'ISSUED',
      voucherNo: `LN-I-${pad6(await nextSeq('loan-issue', session))}`,
    });
    receipt.linkedVoucher = issue._id;
    issue.linkedVoucher = receipt._id;
    for (const l of body.lines) {
      const item = items.get(l.item);
      await loanIn(item, round3(l.qty), session);
      await loanOut(item, round3(l.qty), session);
    }
    await writeLoanTxns(receipt, session);
    await writeLoanTxns(issue, session);
    await receipt.save({ session });
    await issue.save({ session });
    await audit(req, 'CREATE', 'LoanVoucher', receipt._id, `Loan ${receipt.voucherNo} from ${receipt.issueTo}, issued to ${issue.issueTo} as ${issue.voucherNo}`, session);
    return { receipt, issue };
  });
  res.status(201).json(result);
});

/**
 * Loan Deposit: items given back to an office. Any item may be deposited; where the office lent
 * that item, the quantity is set against its oldest loans first, so they show as returned.
 */
router.post('/deposit', canWrite, validate(depositBody), async (req, res) => {
  const voucher = await withTxn(async (session) => {
    const body = req.valid.body;
    const items = await loadItemsForLines(body.lines, session, { allowInactive: true });
    const open = await LoanVoucher.find({
      kind: 'BORROW',
      status: 'POSTED',
      returnStatus: { $ne: 'RETURNED' },
      issueTo: new RegExp(`^${escapeRegex(body.issueTo)}$`, 'i'),
      date: { $lte: body.date },
    })
      .sort({ date: 1, createdAt: 1 })
      .session(session);

    const lines = body.lines.map((l) => {
      let left = round3(l.qty);
      const allocations = [];
      for (const loan of open) {
        const ll = loan.lines.find((x) => x.item.equals(l.item));
        const out = ll ? round3(ll.qty - ll.returnedQty) : 0;
        if (out <= 0) continue;
        const take = Math.min(out, left);
        ll.returnedQty = round3(ll.returnedQty + take);
        allocations.push({ issue: loan._id, qty: take });
        left = round3(left - take);
        if (!left) break;
      }
      return { ...l, qty: round3(l.qty), allocations };
    });

    const touched = open.filter((loan) => lines.some((l) => l.allocations.some((a) => a.issue.equals(loan._id))));
    const doc = new LoanVoucher({
      ...body,
      lines,
      kind: 'DEPOSIT',
      loanLedger: true,
      reference: body.reference || touched.map((t) => t.voucherNo).join(', '),
      voucherNo: `LN-D-${pad6(await nextSeq('loan-deposit', session))}`,
      fy: fyLabel(body.date),
      createdBy: req.user._id,
    });
    for (const l of doc.lines) await loanOut(items.get(l.item.toString()), l.qty, session);
    await writeLoanTxns(doc, session);
    for (const loan of touched) {
      loan.returnStatus = returnStatus(loan);
      await loan.save({ session });
    }
    await doc.save({ session });
    await audit(req, 'CREATE', 'LoanVoucher', doc._id, `Loan deposit ${doc.voucherNo} to ${doc.issueTo}`, session);
    return doc;
  });
  res.status(201).json({ voucher });
});

/** Loan Receipt: items returned by a section, set against its oldest outstanding loan issues. */
router.post('/receipt', canWrite, validate(receiptBody), async (req, res) => {
  const voucher = await withTxn(async (session) => {
    const body = req.valid.body;
    const items = await loadItemsForLines(body.lines, session, { allowInactive: true });
    const open = await LoanVoucher.find({
      kind: 'ISSUE',
      status: 'POSTED',
      returnStatus: { $in: ['ISSUED', 'PARTIAL'] },
      issueTo: new RegExp(`^${escapeRegex(body.issueTo)}$`, 'i'),
      date: { $lte: body.date },
    })
      .sort({ date: 1, createdAt: 1 })
      .session(session);

    const lines = body.lines.map((l) => {
      const item = items.get(l.item);
      let left = round3(l.qty);
      const allocations = [];
      for (const loan of open) {
        const ll = loan.lines.find((x) => x.item.equals(l.item));
        const out = ll ? round3(ll.qty - ll.returnedQty) : 0;
        if (out <= 0) continue;
        const take = Math.min(out, left);
        ll.returnedQty = round3(ll.returnedQty + take);
        allocations.push({ issue: loan._id, qty: take });
        left = round3(left - take);
        if (!left) break;
      }
      if (left > 0) {
        throw badRequest(`${body.issueTo} has only ${round3(l.qty - left)} ${item.uom} of ${item.name} out on loan; cannot receive ${l.qty}`);
      }
      return { ...l, qty: round3(l.qty), allocations };
    });

    const touched = open.filter((loan) => lines.some((l) => l.allocations.some((a) => a.issue.equals(loan._id))));
    const doc = new LoanVoucher({
      ...body,
      lines,
      kind: 'RECEIPT',
      loanLedger: true,
      againstIssue: touched[0]?._id,
      reference: touched.map((t) => t.voucherNo).join(', '),
      voucherNo: `LN-R-${pad6(await nextSeq('loan-receipt', session))}`,
      fy: fyLabel(body.date),
      createdBy: req.user._id,
    });
    for (const l of doc.lines) await loanIn(items.get(l.item.toString()), l.qty, session);
    await writeLoanTxns(doc, session);
    for (const loan of touched) {
      loan.returnStatus = returnStatus(loan);
      await loan.save({ session });
    }
    await doc.save({ session });
    await audit(req, 'CREATE', 'LoanVoucher', doc._id, `Loan return ${doc.voucherNo} by ${doc.issueTo}`, session);
    return doc;
  });
  res.status(201).json({ voucher });
});

/** Cancel one loan voucher and undo what it posted. */
async function cancelOne(doc, req, session) {
  // Reverse exactly the Loan Store Ledger rows this voucher wrote, so the balance always matches the ledger.
  await reverseLoanRows(doc._id, session);
  if (doc.kind === 'RECEIPT' || doc.kind === 'DEPOSIT') {
    // RECEIPT (back from a section) or DEPOSIT (back to an office): undo the returned quantity on each
    // voucher it was set against (older receipts name a single issue).
    const loans = new Map();
    for (const l of doc.lines) {
      const parts = l.allocations?.length ? l.allocations : doc.againstIssue ? [{ issue: doc.againstIssue, qty: l.qty }] : [];
      for (const p of parts) {
        const key = p.issue.toString();
        if (!loans.has(key)) loans.set(key, await LoanVoucher.findById(p.issue).session(session));
        const ll = loans.get(key)?.lines.find((x) => x.item.equals(l.item));
        if (ll) ll.returnedQty = Math.max(0, round3(ll.returnedQty - p.qty));
      }
    }
    for (const loan of loans.values()) {
      if (!loan) continue;
      loan.returnStatus = returnStatus(loan);
      await loan.save({ session });
    }
  }
  doc.set({ status: 'CANCELLED', cancelledBy: req.user._id, cancelledAt: new Date(), cancelReason: req.valid.body.reason });
  await doc.save({ session });
  await audit(req, 'CANCEL', 'LoanVoucher', doc._id, `Cancelled ${doc.voucherNo}: ${req.valid.body.reason}`, session);
}

router.post('/:id/cancel', canWrite, validate(idParam, 'params'), validate(cancelBody), async (req, res) => {
  const voucher = await withTxn(async (session) => {
    const doc = await LoanVoucher.findById(req.valid.params.id).session(session);
    if (!doc) throw notFound('Loan voucher not found');
    if (doc.status !== 'POSTED') throw badRequest('Voucher is already cancelled');
    if (!doc.loanLedger) throw conflict('This voucher is from before the separate Loan Store Ledger. Run the loan store migration first.');
    // A Loan From Other Sources pair (receipt + issue) is cancelled together.
    const partner = doc.linkedVoucher ? await LoanVoucher.findById(doc.linkedVoucher).session(session) : null;
    const pair = [doc, ...(partner?.status === 'POSTED' ? [partner] : [])];
    const returned = pair.find((v) => ['ISSUE', 'BORROW'].includes(v.kind) && v.lines.some((l) => l.returnedQty > 0));
    if (returned) {
      const what = returned.kind === 'ISSUE' ? 'returned by the section' : 'deposited back to the office';
      throw conflict(`Items on ${returned.voucherNo} have already been ${what}. Cancel those vouchers first.`);
    }
    for (const v of pair) await cancelOne(v, req, session);
    return doc;
  });
  res.json({ voucher });
});

/**
 * Permanently delete a cancelled loan voucher (admin only). A Loan From Other Sources pair goes together.
 * Refused while a posted loan return / deposit still refers to it.
 */
router.delete('/:id', adminOnly, validate(idParam, 'params'), async (req, res) => {
  const doc = await LoanVoucher.findById(req.valid.params.id).lean();
  if (!doc) throw notFound('Loan voucher not found');
  const ids = [doc._id, ...(doc.linkedVoucher ? [doc.linkedVoucher] : [])];
  const usedBy = await LoanVoucher.findOne({
    _id: { $nin: ids },
    status: 'POSTED',
    $or: [{ againstIssue: { $in: ids } }, { 'lines.allocations.issue': { $in: ids } }],
  }).lean();
  if (usedBy) throw conflict(`${usedBy.voucherNo} still refers to ${doc.voucherNo}. Cancel it first.`);
  const partner = doc.linkedVoucher ? await LoanVoucher.findById(doc.linkedVoucher).lean() : null;
  if (partner && partner.status !== 'CANCELLED') throw badRequest(`${doc.voucherNo} is paired with ${partner.voucherNo}, which is not cancelled.`);
  const gone = [];
  for (const v of [doc, ...(partner ? [partner] : [])]) {
    const d = await deleteCancelled(LoanVoucher, v._id, { label: 'Loan voucher', noField: 'voucherNo' });
    gone.push(d.voucherNo);
    await audit(req, 'DELETE', 'LoanVoucher', d._id, `Deleted cancelled ${d.voucherNo} (cancelled: ${d.cancelReason || '-'})`);
  }
  res.json({ ok: true, deleted: gone });
});

export default router;
