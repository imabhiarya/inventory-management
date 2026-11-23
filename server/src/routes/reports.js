import { Router } from 'express';
import { z } from 'zod';
import StockTxn from '../models/StockTxn.js';
import { Issue } from '../models/Voucher.js';
import { validate, zDay, zOptLedgerKey } from '../middleware/validate.js';
import { getLedgers } from '../models/misc.js';
import { VOUCHER_TYPES, VOUCHER_TYPE_KEYS } from '../config/constants.js';
import { periodBalance, summariseByLedger } from '../services/reports.js';
import { fyRange, monthRange, quarterRange, today } from '../utils/dates.js';
import { badRequest, round2, round3 } from '../utils/httpError.js';
import { itemLifeLots, lifeBands } from '../services/itemLife.js';
import { lowStockItems } from '../services/stockView.js';

const router = Router();
const optLedger = zOptLedgerKey;

/** MSTB / QSTB / ASTB / BER-SVY OFF: store balance for a month, quarter, FY or custom range. */
router.get(
  '/store-balance',
  validate(
    z.object({
      period: z.enum(['monthly', 'quarterly', 'yearly', 'custom']),
      fy: z.string().optional(),
      month: z.string().optional(),
      quarter: z.string().optional(),
      from: zDay.optional(),
      to: zDay.optional(),
      ledger: optLedger,
    }),
    'query',
  ),
  async (req, res) => {
    const q = req.valid.query;
    let range;
    if (q.period === 'monthly') range = monthRange(q.month);
    else if (q.period === 'quarterly') range = quarterRange(q.fy, q.quarter);
    else if (q.period === 'yearly') range = fyRange(q.fy);
    else if (q.from && q.to) range = { from: q.from, to: q.to };
    if (!range) throw badRequest('Select a valid report period');
    if (range.from > range.to) throw badRequest('From date must be on or before To date');
    const rows = await periodBalance({ ...range, ledger: q.ledger });
    res.json({ from: range.from, to: range.to, rows, ...summariseByLedger(rows, await getLedgers()) });
  },
);

/** Handing / Taking over of all stores: FY-to-date summary per ledger plus item-wise appendices. */
router.get('/handing-taking', validate(z.object({ date: zDay, fy: z.string() }), 'query'), async (req, res) => {
  const { date, fy } = req.valid.query;
  const range = fyRange(fy);
  if (!range) throw badRequest('Select a valid financial year');
  const to = date < range.to ? date : range.to;
  if (to < range.from) throw badRequest('Handing/taking date is before the start of the selected financial year');
  const rows = await periodBalance({ from: range.from, to });
  res.json({ from: range.from, to, rows, ...summariseByLedger(rows, await getLedgers()) });
});

/** Item-wise balance as on a date. */
router.get(
  '/stock-statement',
  validate(z.object({ asOn: zDay.optional(), ledger: optLedger }), 'query'),
  async (req, res) => {
    const asOn = req.valid.query.asOn || today();
    const rows = await periodBalance({ from: new Date(0), to: asOn, ledger: req.valid.query.ledger });
    res.json({ asOn, rows, ...summariseByLedger(rows, await getLedgers()) });
  },
);

router.get('/low-stock', validate(z.object({ ledger: optLedger }), 'query'), async (req, res) => {
  const items = await lowStockItems({ ledger: req.valid.query.ledger });
  res.json({
    rows: items.map((i) => ({ ...i, shortfall: Math.max(0, i.minStock - i.currentStock) })),
  });
});

/** All ledger movements in a period. */
router.get(
  '/transactions',
  validate(
    z.object({
      from: zDay,
      to: zDay,
      ledger: optLedger,
      voucherType: z.enum(VOUCHER_TYPE_KEYS).optional().or(z.literal('').transform(() => undefined)),
    }),
    'query',
  ),
  async (req, res) => {
    const { from, to, ledger, voucherType } = req.valid.query;
    const filter = { date: { $gte: from, $lte: to } };
    if (ledger) filter.ledger = ledger;
    if (voucherType) filter.voucherType = voucherType;
    const txns = await StockTxn.find(filter)
      .sort({ date: 1, createdAt: 1, seq: 1 })
      .limit(20000)
      .populate('item', 'code name uom')
      .lean();
    res.json({
      rows: txns.map((t) => ({
        ...t,
        voucherTypeLabel: VOUCHER_TYPES[t.voucherType],
        value: round2((t.receiptQty || t.issueQty) * t.rate),
      })),
    });
  },
);

/**
 * Certified Issue Voucher: all posted Monthly issues in a month,
 * consolidated per item, with the issue vouchers it covers.
 */
router.get(
  '/civ',
  validate(
    z.object({
      month: z.string().regex(/^\d{4}-\d{2}$/, 'Select a month'),
      ledger: optLedger,
      issueTo: z.string().trim().max(160).optional().default(''),
    }),
    'query',
  ),
  async (req, res) => {
    const { month, ledger, issueTo } = req.valid.query;
    const range = monthRange(month);
    if (!range) throw badRequest('Select a valid month');
    // The CIV month chosen on the issue; older monthly issues without one fall back to their issue date.
    const filter = {
      status: 'POSTED',
      frequency: 'MONTHLY',
      $or: [{ civMonth: month }, { civMonth: { $in: ['', null] }, date: { $gte: range.from, $lte: range.to } }],
    };
    if (ledger) filter.ledger = ledger;
    if (issueTo) filter.issueTo = issueTo;
    const issues = await Issue.find(filter).sort({ date: 1, issueNo: 1 }).populate('lines.item', 'code name uom ledger').lean();

    const byItem = new Map();
    for (const v of issues) {
      for (const l of v.lines) {
        const key = l.item._id.toString();
        const row = byItem.get(key) || { item: l.item, ledger: v.ledger, qty: 0, amount: 0, ledgerPages: new Set(), issueNos: new Set() };
        row.qty += l.qty;
        row.amount += l.amount;
        if (l.ledgerPageNo) row.ledgerPages.add(l.ledgerPageNo);
        row.issueNos.add(v.issueNo);
        byItem.set(key, row);
      }
    }
    const rows = [...byItem.values()]
      .map((r) => ({
        ...r,
        qty: round3(r.qty),
        amount: round2(r.amount),
        rate: r.qty ? round2(r.amount / r.qty) : 0,
        ledgerPages: [...r.ledgerPages].join(', '),
        issueNos: [...r.issueNos].join(', '),
      }))
      .sort((a, b) => a.ledger.localeCompare(b.ledger) || a.item.code.localeCompare(b.item.code));

    res.json({
      from: range.from,
      to: range.to,
      rows,
      totalAmount: round2(rows.reduce((s, r) => s + r.amount, 0)),
      issues: issues.map((v) => ({ _id: v._id, issueNo: v.issueNo, oldIvNo: v.oldIvNo, date: v.date, issueTo: v.issueTo, authorityRef: v.authorityRef, totalAmount: v.totalAmount })),
      units: [...new Set(issues.map((v) => v.issueTo))],
    });
  },
);

/** Ledgers left out of the BER / Survey Off report: loaned stock and salvage are not boarded for BER. */
const BER_EXCLUDED_LEDGERS = ['LOAN', 'SALVAGE'];

/**
 * BER / Survey Off – Item Life: stock still held, by the Receipt Voucher it came in on, with its
 * life (age) as on a date. `minYears` keeps only lots at least that old; the bands always cover all.
 */
router.get(
  '/item-life',
  validate(
    z.object({
      asOn: zDay.optional(),
      ledger: optLedger,
      minYears: z.coerce.number().int().min(0).max(100).optional().or(z.literal('').transform(() => undefined)),
    }),
    'query',
  ),
  async (req, res) => {
    const { ledger, minYears } = req.valid.query;
    const asOn = req.valid.query.asOn || today();
    const all = await itemLifeLots({ asOn, ledger, excludeLedgers: BER_EXCLUDED_LEDGERS });
    // Every line is listed (ledger-wise); with a life chosen each is marked BER due or within life.
    const rows = all.map((r) => ({ ...r, due: minYears ? r.ageValue != null && r.ageValue >= minYears : null }));
    const above = rows.filter((r) => r.due);
    const below = minYears ? rows.filter((r) => !r.due) : [];
    res.json({
      asOn,
      rows,
      bands: lifeBands(all),
      threshold: minYears
        ? {
            years: minYears,
            above: { lots: above.length, qty: round3(above.reduce((s, r) => s + r.heldQty, 0)), items: [...new Set(above.map((r) => `${r.item.name} (${r.item.code})`))] },
            below: { lots: below.length, qty: round3(below.reduce((s, r) => s + r.heldQty, 0)) },
          }
        : null,
    });
  },
);

export default router;
