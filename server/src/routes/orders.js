import { Router } from 'express';
import { z } from 'zod';
import { PurchaseOrder, orderStatus } from '../models/PurchaseOrder.js';
import { nextSeq, audit } from '../models/misc.js';
import { canWrite, adminOnly } from '../middleware/auth.js';
import { validate, idParam, zDay, zText, zReqText } from '../middleware/validate.js';
import { badRequest, notFound, escapeRegex, round2, round3 } from '../utils/httpError.js';
import { pad6 } from '../services/vouchers.js';
import { fyLabel, fyRange } from '../utils/dates.js';

/** The "Project contingency" code head carries the office it is for. */
export const isProjectContingency = (codeHead) => /project\s*contingency/i.test(codeHead || '');

const zFy = z.string().trim().regex(/^\d{4}-\d{2}$/, 'Financial year must look like 2026-27');

const router = Router();

const optDay = zDay.optional().or(z.literal('').transform(() => undefined)).or(z.null().transform(() => undefined));
const money = z.coerce.number().min(0).max(1e12).optional().default(0);
const DATE_FIELDS = ['orderDate', 'demandDate', 'approvalDate', 'notingDate', 'expectedDelivery', 'deliveredOn', 'billDate', 'billForwardedOn', 'paymentDate'];

const orderFields = z.object({
    mode: zReqText('Mode of procurement', 60),
    supplyOrderNo: zText(120).optional().default(''),
    gemOrderId: zText(80).optional().default(''),
    orderDate: zDay,
    vendor: zReqText('Firm / Vendor', 200),
    vendorGstin: zText(20).optional().default(''),
    demandNo: zText(80).optional().default(''),
    demandDate: optDay,
    demandFrom: zText(160).optional().default(''),
    approvalDate: optDay,
    approvedBy: zText(120).optional().default(''),
    notingNo: zText(80).optional().default(''),
    notingDate: optDay,
    codeHead: zText(160).optional().default(''), // from the Orders code head list (e.g. "2210 – Office Expenses")
    projectOffice: zText(160).optional().default(''),
    budgetYear: zFy.optional().or(z.literal('').transform(() => undefined)), // defaults to the order date's FY
    ledger: zText(40).optional().default(''),
    lines: z
      .array(
        z.object({
          description: zReqText('Item description', 300),
          qty: z.coerce.number().min(0).max(1e9).default(0),
          uom: zText(20).optional().default(''),
          rate: z.coerce.number().min(0).max(1e12).default(0),
        }),
      )
      .max(200)
      .default([]),
    orderValue: money, // used only when no item lines are given
    expectedDelivery: optDay,
    deliveredOn: optDay,
    receiptRef: zText(120).optional().default(''),
    billNo: zText(80).optional().default(''),
    billDate: optDay,
    billAmount: money,
    billForwardedOn: optDay,
    accountsOffice: zText(120).optional().default(''),
    forwardingLetterNo: zText(120).optional().default(''),
    paymentDate: optDay,
    paymentAmount: money,
    paymentRef: zText(120).optional().default(''),
    cancelled: z.boolean().optional().default(false),
    remarks: zText(1000).optional().default(''),
  });

const body = orderFields
  .superRefine((b, ctx) => {
    if (isProjectContingency(b.codeHead) && !b.projectOffice) ctx.addIssue({ code: 'custom', path: ['projectOffice'], message: 'Select the Office for Project contingency' });
    const after = (a, bKey, msg) => b[a] && b[bKey] && b[a] < b[bKey] && ctx.addIssue({ code: 'custom', path: [a], message: msg });
    after('paymentDate', 'billForwardedOn', 'Payment date cannot be before the bill was forwarded');
    after('billForwardedOn', 'billDate', 'Bill cannot be forwarded before its date');
    after('orderDate', 'demandDate', 'Order date cannot be before the demand date');
  })
  .transform((b) => {
    const lines = b.lines.map((l) => ({ ...l, qty: round3(l.qty), amount: round2(l.qty * l.rate) }));
    return {
      ...b,
      projectOffice: isProjectContingency(b.codeHead) ? b.projectOffice : '',
      budgetYear: b.budgetYear || fyLabel(b.orderDate),
      lines,
      orderValue: lines.length ? round2(lines.reduce((s, l) => s + l.amount, 0)) : round2(b.orderValue),
    };
  });

const withStatus = (o) => ({ ...o, status: orderStatus(o) });

const listQuery = z.object({
  status: z.enum(['ORDERED', 'DELIVERED', 'BILL_FORWARDED', 'PAID', 'CANCELLED', 'PENDING_PAYMENT', '']).optional(),
  mode: zText(60).optional(),
  codeHead: zText(160).optional(),
  from: optDay,
  to: optDay,
  q: zText(100).optional(),
  fy: zFy.optional().or(z.literal('').transform(() => undefined)),
});

/** Order Report / register: filter by status, mode, code head, order dates and text. */
router.get('/', validate(listQuery, 'query'), async (req, res) => {
  const { status, mode, codeHead, from, to, q, fy } = req.valid.query;
  const filter = {};
  if (fy) {
    // Orders of that budget / financial year (older records without one: by order date).
    const start = new Date(Date.UTC(Number(fy.slice(0, 4)), 3, 1));
    const end = new Date(Date.UTC(Number(fy.slice(0, 4)) + 1, 2, 31));
    filter.$and = [{ $or: [{ budgetYear: fy }, { budgetYear: { $in: ['', null] }, orderDate: { $gte: start, $lte: end } }] }];
  }
  if (mode) filter.mode = mode;
  if (codeHead) filter.codeHead = codeHead;
  if (from || to) filter.orderDate = { ...(from && { $gte: from }), ...(to && { $lte: to }) };
  if (q) {
    const rx = new RegExp(escapeRegex(q), 'i');
    filter.$or = ['orderNo', 'supplyOrderNo', 'gemOrderId', 'vendor', 'demandNo', 'demandFrom', 'notingNo', 'billNo', 'forwardingLetterNo', 'paymentRef', 'lines.description', 'projectOffice'].map(
      (f) => ({ [f]: rx }),
    );
  }
  let rows = (await PurchaseOrder.find(filter).sort({ orderDate: -1, createdAt: -1 }).limit(2000).lean()).map(withStatus);
  if (status === 'PENDING_PAYMENT') rows = rows.filter((r) => !['PAID', 'CANCELLED'].includes(r.status));
  else if (status) rows = rows.filter((r) => r.status === status);
  const live = rows.filter((r) => !r.cancelled);
  const sum = (k) => round2(live.reduce((s, r) => s + (r[k] || 0), 0));
  res.json({ rows, totals: { orders: live.length, orderValue: sum('orderValue'), billAmount: sum('billAmount'), paymentAmount: sum('paymentAmount') } });
});

/**
 * Payments (MER): what was paid in each month of a financial year (Apr–Mar), per code head.
 * A payment counts in the month of its payment date, whatever the order's own budget year.
 * Cancelled orders are left out, as in the Order Report totals.
 */
router.get('/payments', validate(z.object({ fy: zFy }), 'query'), async (req, res) => {
  const { fy } = req.valid.query;
  const range = fyRange(fy);
  if (!range) throw badRequest('Financial year must look like 2026-27');
  const startYear = range.from.getUTCFullYear();
  const months = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(Date.UTC(startYear, 3 + i, 1));
    return { key: d.toISOString().slice(0, 7), label: d.toLocaleString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' }) };
  });
  const orders = await PurchaseOrder.find({ cancelled: { $ne: true }, paymentDate: { $gte: range.from, $lte: range.to }, paymentAmount: { $gt: 0 } })
    .sort({ paymentDate: 1, orderNo: 1 })
    .select('orderNo vendor supplyOrderNo codeHead projectOffice budgetYear paymentDate paymentAmount paymentRef')
    .lean();

  const heads = new Map();
  const monthTotals = Array(12).fill(0);
  for (const o of orders) {
    const m = (o.paymentDate.getUTCFullYear() - startYear) * 12 + o.paymentDate.getUTCMonth() - 3;
    const head = o.codeHead || '';
    if (!heads.has(head)) heads.set(head, { codeHead: head, months: Array(12).fill(0), total: 0, payments: 0 });
    const row = heads.get(head);
    row.months[m] += o.paymentAmount;
    row.total += o.paymentAmount;
    row.payments += 1;
    monthTotals[m] += o.paymentAmount;
  }
  const rows = [...heads.values()]
    .map((r) => ({ ...r, months: r.months.map(round2), total: round2(r.total) }))
    .sort((a, b) => (!a.codeHead) - (!b.codeHead) || a.codeHead.localeCompare(b.codeHead, 'en', { numeric: true }));
  res.json({
    fy,
    months,
    rows,
    totals: { months: monthTotals.map(round2), total: round2(monthTotals.reduce((s, v) => s + v, 0)), payments: orders.length },
    payments: orders.map((o) => ({ ...o, month: o.paymentDate.toISOString().slice(0, 7) })),
  });
});

router.get('/:id', validate(idParam, 'params'), async (req, res) => {
  const o = await PurchaseOrder.findById(req.valid.params.id).lean();
  if (!o) throw notFound('Order not found');
  res.json({ order: withStatus(o) });
});

router.post('/', canWrite, validate(body), async (req, res) => {
  const o = await PurchaseOrder.create({ ...req.valid.body, orderNo: `ORD-${pad6(await nextSeq('order'))}`, createdBy: req.user._id });
  await audit(req, 'CREATE', 'PurchaseOrder', o._id, `Order ${o.orderNo} (${o.mode}) to ${o.vendor}`);
  res.status(201).json({ order: withStatus(o.toObject()) });
});

router.put('/:id', canWrite, validate(idParam, 'params'), validate(body), async (req, res) => {
  const data = req.valid.body;
  // Cleared dates are removed, not left at their old values.
  const unset = Object.fromEntries(DATE_FIELDS.filter((k) => !data[k]).map((k) => [k, 1]));
  const set = Object.fromEntries(Object.entries(data).filter(([k, v]) => !(DATE_FIELDS.includes(k) && !v)));
  const o = await PurchaseOrder.findByIdAndUpdate(req.valid.params.id, { $set: set, ...(Object.keys(unset).length && { $unset: unset }) }, { returnDocument: 'after', runValidators: true }).lean();
  if (!o) throw notFound('Order not found');
  await audit(req, 'UPDATE', 'PurchaseOrder', o._id, `Order ${o.orderNo} updated (${orderStatus(o)})`);
  res.json({ order: withStatus(o) });
});

router.delete('/:id', adminOnly, validate(idParam, 'params'), async (req, res) => {
  const o = await PurchaseOrder.findById(req.valid.params.id);
  if (!o) throw notFound('Order not found');
  if (o.paymentDate) throw badRequest(`${o.orderNo} has a payment recorded and cannot be deleted. Mark it cancelled instead.`);
  await o.deleteOne();
  await audit(req, 'DELETE', 'PurchaseOrder', o._id, `Deleted order ${o.orderNo} (${o.vendor})`);
  res.json({ ok: true });
});

// ---------- Import (GeM / Excel / Word, parsed in the browser) ----------

/** Order number used to recognise the same order again: Supply Order / Contract No., else GeM Order ID. */
const orderKey = (o) => String(o.supplyOrderNo || o.gemOrderId || '').trim().toUpperCase().replace(/\s+/g, '');

async function findExisting(o) {
  const or = [];
  if (o.supplyOrderNo) or.push({ supplyOrderNo: new RegExp(`^\\s*${escapeRegex(o.supplyOrderNo.trim())}\\s*$`, 'i') });
  if (o.gemOrderId) or.push({ gemOrderId: new RegExp(`^\\s*${escapeRegex(o.gemOrderId.trim())}\\s*$`, 'i') });
  return or.length ? PurchaseOrder.findOne({ $or: or }).lean() : null;
}

/** Only fields that the file actually filled (blank values never overwrite what was typed earlier). */
const filled = (o) =>
  Object.fromEntries(Object.entries(o).filter(([k, v]) => v !== '' && v != null && !(Array.isArray(v) && !v.length) && !(k !== 'lines' && typeof v === 'number' && v === 0)));

const dayStr = (d) => (d ? new Date(d).toISOString().slice(0, 10) : undefined);
const asInput = (doc) => ({
  ...Object.fromEntries(Object.keys(orderFields.shape).map((k) => [k, doc[k]])),
  ...Object.fromEntries(DATE_FIELDS.map((k) => [k, dayStr(doc[k])])),
  lines: (doc.lines || []).map(({ description, qty, uom, rate }) => ({ description, qty, uom, rate })),
});

/**
 * Import orders. Each is matched by its order number (Supply Order / Contract No., else GeM Order ID):
 * a match is UPDATED with the fields the file has; otherwise a new order is created. With `dryRun`,
 * nothing is saved and the plan (new / update / error per order) is returned for the preview.
 */
router.post(
  '/import',
  canWrite,
  validate(z.object({ orders: z.array(z.record(z.string(), z.unknown())).min(1).max(500), dryRun: z.boolean().optional().default(false) })),
  async (req, res) => {
    const { orders, dryRun } = req.valid.body;
    const seen = new Set();
    const plan = [];
    for (const [i, raw] of orders.entries()) {
      const key = orderKey(raw);
      const label = raw.supplyOrderNo || raw.gemOrderId || `Row ${i + 1}`;
      if (!key) {
        plan.push({ index: i, label, action: 'error', error: 'No order / contract number — it is needed to avoid duplicates' });
        continue;
      }
      if (seen.has(key)) {
        plan.push({ index: i, label, action: 'error', error: 'Same order number appears twice in this file' });
        continue;
      }
      seen.add(key);
      const existing = await findExisting(raw);
      const merged = existing ? { ...asInput(existing), ...filled(raw) } : { mode: 'GeM', ...filled(raw) };
      const parsed = body.safeParse(merged);
      if (!parsed.success) {
        plan.push({ index: i, label, action: 'error', error: parsed.error.issues.map((x) => `${x.path.join('.') || 'order'}: ${x.message}`).join('; ') });
        continue;
      }
      const item = { index: i, label, action: existing ? 'update' : 'create', orderNo: existing?.orderNo, vendor: parsed.data.vendor, orderValue: parsed.data.orderValue };
      if (!dryRun) {
        if (existing) {
          await PurchaseOrder.updateOne({ _id: existing._id }, { $set: parsed.data });
        } else {
          const o = await PurchaseOrder.create({ ...parsed.data, orderNo: `ORD-${pad6(await nextSeq('order'))}`, createdBy: req.user._id });
          item.orderNo = o.orderNo;
        }
      }
      plan.push(item);
    }
    if (!dryRun) {
      const n = (a) => plan.filter((p) => p.action === a).length;
      await audit(req, 'IMPORT', 'PurchaseOrder', null, `Imported orders: ${n('create')} new, ${n('update')} updated, ${n('error')} skipped`);
    }
    res.json({ dryRun, plan });
  },
);

export default router;
