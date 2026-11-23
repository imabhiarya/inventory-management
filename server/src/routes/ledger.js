import { Router } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import Item from '../models/Item.js';
import StockTxn from '../models/StockTxn.js';
import { Receipt, Issue } from '../models/Voucher.js';
import { userRemarks, remarkKey } from '../services/remarks.js';
import { validate, zDay, zId, zLedgerKey } from '../middleware/validate.js';
import { VOUCHER_TYPES, VOUCHER_TYPE_KEYS } from '../config/constants.js';
import { badRequest, notFound, round3 } from '../utils/httpError.js';
import { today } from '../utils/dates.js';

const router = Router();
const MAX_ROWS = 10000;

const blank = z.literal('').transform(() => undefined);
const query = z.object({
  ledger: zLedgerKey,
  item: zId.optional().or(blank),
  // Both dates are optional: no From = from the first entry; no To = up to today.
  from: zDay.optional().or(blank),
  to: zDay.optional().or(blank),
  voucherType: z.enum(VOUCHER_TYPE_KEYS).optional().or(blank),
  // ALL = every item of the ledger; HELD = items with a balance; ZERO = items holding nothing (as on To date).
  holding: z.enum(['ALL', 'HELD', 'ZERO']).default('ALL'),
});
const EARLIEST = new Date(Date.UTC(1900, 0, 1));

/**
 * Master Ledger: movements with running balance, item by item (item-code order). Every item of the ledger
 * is listed — one with no entries gets a "Nil" line — and `holding` keeps only items with / without a balance.
 */
router.get('/', validate(query, 'query'), async (req, res) => {
  const { ledger, item: itemId, voucherType, holding } = req.valid.query;
  const from = req.valid.query.from || EARLIEST;
  const to = req.valid.query.to || today();
  if (from > to) throw badRequest('From date must be on or before To date');

  let item;
  if (itemId) {
    item = await Item.findById(itemId).lean();
    if (!item) throw notFound('Item not found');
    if (item.ledger !== ledger) throw badRequest('Item does not belong to this ledger');
  }
  const scope = itemId ? { item: new mongoose.Types.ObjectId(itemId) } : { ledger };

  // Balance brought forward before `from`, per item.
  const openingAgg = await StockTxn.aggregate([
    { $match: { ...scope, date: { $lt: from } } },
    { $group: { _id: '$item', bal: { $sum: { $subtract: ['$receiptQty', '$issueQty'] } } } },
  ]);
  const running = new Map(openingAgg.map((o) => [o._id.toString(), round3(o.bal)]));

  const txns = await StockTxn.find({ ...scope, date: { $gte: from, $lte: to } })
    .sort({ date: 1, createdAt: 1, seq: 1 })
    .limit(MAX_ROWS + 1)
    .populate('item', 'code name description uom ledgerPage')
    .lean();
  if (txns.length > MAX_ROWS) throw badRequest('Too many entries; narrow the date range or pick an item');

  const rows = [];
  // Opening line(s) for items that had a balance before the period.
  if (itemId || running.size) {
    const openingItems = itemId ? [item] : await Item.find({ _id: { $in: [...running.keys()] } }).sort({ code: 1 }).lean();
    for (const it of openingItems) {
      const bal = running.get(it._id.toString()) || 0;
      if (bal !== 0) {
        rows.push({
          date: from,
          voucherType: 'Opening',
          voucherNo: 'B/F',
          item: { _id: it._id, code: it.code, name: it.name, uom: it.uom, ledgerPage: it.ledgerPage || '', description: it.description || '' },
          receiptQty: null,
          issueQty: null,
          balance: bal,
          remarks: '',
        });
      }
    }
  }

  let totalReceipt = 0;
  let totalIssue = 0;
  for (const t of txns) {
    const key = t.item._id.toString();
    const bal = round3((running.get(key) || 0) + t.receiptQty - t.issueQty);
    running.set(key, bal);
    totalReceipt += t.receiptQty;
    totalIssue += t.issueQty;
    if (voucherType && t.voucherType !== voucherType) continue;
    rows.push({
      _id: t._id,
      date: t.date,
      voucherType: VOUCHER_TYPES[t.voucherType],
      voucherNo: t.voucherNo,
      oldRvNo: t.oldRvNo || '',
      oldIvNo: t.oldIvNo || '',
      voucherId: t.voucherId,
      kind: t.voucherType, // RECEIPT / ISSUE / OPENING …, to attach voucher details below
      seq: t.seq,
      item: t.item,
      receiptQty: t.receiptQty || null,
      issueQty: t.issueQty || null,
      balance: bal,
      remarks: t.remarks,
    });
  }

  // Voucher details for the register: PO / sanction no. & date and Source (receipts), Issued To (issues).
  const idsOf = (kind) => rows.filter((r) => r.kind === kind && r.voucherId).map((r) => r.voucherId);
  const [receipts, issues] = await Promise.all([
    Receipt.find({ _id: { $in: idsOf('RECEIPT') } }, { poNo: 1, poDate: 1, source: 1, oldLedgerPage: 1 }).lean(),
    Issue.find({ _id: { $in: idsOf('ISSUE') } }, { issueTo: 1 }).lean(),
  ]);
  const rById = new Map(receipts.map((v) => [v._id.toString(), v]));
  const iById = new Map(issues.map((v) => [v._id.toString(), v]));
  // Remarks: only what the user typed on the voucher (never the auto-filled text), else blank.
  const MODEL = { RECEIPT: 'RECEIPT', ISSUE: 'ISSUE', LOAN_ISSUE: 'LOAN', LOAN_RETURN: 'LOAN', LOAN_IN: 'LOAN' };
  const typed = await userRemarks(rows.filter((r) => MODEL[r.kind]).map((r) => ({ model: MODEL[r.kind], voucherId: r.voucherId, seq: r.seq })));
  for (const r of rows) {
    if (r.kind) r.remarks = MODEL[r.kind] ? typed.get(remarkKey(r.voucherId, r.seq)) || '' : '';
    const id = r.voucherId?.toString();
    if (r.kind === 'RECEIPT' && rById.has(id)) {
      const v = rById.get(id);
      Object.assign(r, { poNo: v.poNo || '', poDate: v.poDate || null, source: v.source || '', oldLedgerPage: v.oldLedgerPage || '' });
    } else if (r.kind === 'ISSUE' && iById.has(id)) {
      r.issueTo = iById.get(id).issueTo || '';
    }
  }

  // Every item of the ledger (or the one picked), so items without entries are listed too.
  const ledgerItems = itemId ? [item] : await Item.find({ ledger }).sort({ code: 1 }).lean();
  const closing = (id) => running.get(id.toString()) || 0;
  const keep = (id) => holding === 'ALL' || (holding === 'HELD' ? closing(id) > 0 : closing(id) === 0);
  const withEntries = new Set(rows.map((r) => r.item._id.toString()));
  if (!voucherType) {
    for (const it of ledgerItems) {
      if (withEntries.has(it._id.toString())) continue;
      rows.push({
        date: null,
        voucherType: 'Nil',
        voucherNo: '—',
        item: { _id: it._id, code: it.code, name: it.name, uom: it.uom, ledgerPage: it.ledgerPage || '', description: it.description || '' },
        receiptQty: null,
        issueQty: null,
        balance: closing(it._id),
        remarks: '',
      });
    }
  }
  // Item by item in item-code order; entries keep their date order within each item.
  const order = new Map(ledgerItems.map((it, i) => [it._id.toString(), i]));
  const byItem = rows
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => keep(r.item._id))
    .sort((a, b) => (order.get(a.r.item._id.toString()) ?? 1e9) - (order.get(b.r.item._id.toString()) ?? 1e9) || a.i - b.i)
    .map(({ r }) => r);

  res.json({
    from: req.valid.query.from || null,
    to,
    rows: byItem,
    summary: item
      ? {
          item: { code: item.code, name: item.name, description: item.description || '', uom: item.uom, ledgerPage: item.ledgerPage || '' },
          openingQty: round3(openingAgg[0]?.bal || 0),
          totalReceipt: round3(totalReceipt),
          totalIssue: round3(totalIssue),
          closingQty: running.get(itemId) ?? round3(openingAgg[0]?.bal || 0),
        }
      : null,
  });
});

export default router;
