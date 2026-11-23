import { Router } from 'express';
import { z } from 'zod';
import { Demand } from '../models/Demand.js';
import Item from '../models/Item.js';
import { nextSeq, audit } from '../models/misc.js';
import { canWrite, adminOnly } from '../middleware/auth.js';
import { validate, idParam, zId, zDay, zText, zReqText, zQty } from '../middleware/validate.js';
import { badRequest, notFound, escapeRegex, round3 } from '../utils/httpError.js';
import { pad6, peekNextNo } from '../services/vouchers.js';

const router = Router();
const ITEM_FIELDS = 'code name description uom ledger currentStock';

const body = z.object({
  date: zDay,
  unit: zReqText('Unit', 160),
  demandedTo: zText(200).optional().default(''),
  frequency: zText(60).optional().default('Regular'),
  subSection: zText(120).optional().default(''),
  authority: zText(160).optional().default(''),
  remarks: zText(500).optional().default(''),
  lines: z
    .array(z.object({ item: zId, qty: zQty, rate: z.coerce.number().min(0).max(1e12).optional().default(0), remarks: zText(200).optional().default('') }))
    .min(1, 'Add at least one item')
    .max(200),
});

/** Items of any ledger may be demanded; each must exist and appear once. */
async function checkItems(lines) {
  const ids = lines.map((l) => l.item);
  if (new Set(ids).size !== ids.length) throw badRequest('An item appears twice on the demand — combine the quantities');
  const found = await Item.countDocuments({ _id: { $in: ids } });
  if (found !== ids.length) throw badRequest('One or more items were not found');
  return lines.map((l) => ({ ...l, qty: round3(l.qty), rate: Math.round((l.rate || 0) * 100) / 100 }));
}

const listQuery = z.object({
  from: zDay.optional().or(z.literal('').transform(() => undefined)),
  to: zDay.optional().or(z.literal('').transform(() => undefined)),
  unit: zText(160).optional(),
  frequency: zText(60).optional(),
  q: zText(100).optional(),
  // 'no' = not yet in a consolidated demand (for picking demands to consolidate)
  consolidated: z.enum(['yes', 'no', '']).optional(),
});

router.get('/', validate(listQuery, 'query'), async (req, res) => {
  const { from, to, unit, q, frequency, consolidated } = req.valid.query;
  const filter = {};
  if (unit) filter.unit = unit;
  if (frequency) filter.frequency = frequency;
  if (consolidated === 'no') filter['consolidatedIn.id'] = { $exists: false };
  if (consolidated === 'yes') filter['consolidatedIn.id'] = { $exists: true };
  if (from || to) filter.date = { ...(from && { $gte: from }), ...(to && { $lte: to }) };
  if (q) {
    const rx = new RegExp(escapeRegex(q), 'i');
    filter.$or = ['demandNo', 'unit', 'subSection', 'authority', 'remarks', 'demandedTo', 'frequency'].map((f) => ({ [f]: rx }));
  }
  const rows = await Demand.find(filter).sort({ date: -1, createdAt: -1 }).limit(500).populate('lines.item', ITEM_FIELDS).lean();
  res.json({ rows });
});

router.get('/next-no', async (req, res) => {
  res.json({ next: await peekNextNo('demand', 'DMD-') });
});

router.get('/:id', validate(idParam, 'params'), async (req, res) => {
  const d = await Demand.findById(req.valid.params.id).populate('lines.item', ITEM_FIELDS).lean();
  if (!d) throw notFound('Demand not found');
  res.json({ demand: d });
});

router.post('/', canWrite, validate(body), async (req, res) => {
  const lines = await checkItems(req.valid.body.lines);
  const d = await Demand.create({ ...req.valid.body, lines, demandNo: `DMD-${pad6(await nextSeq('demand'))}`, createdBy: req.user._id });
  await audit(req, 'CREATE', 'Demand', d._id, `Demand ${d.demandNo} from ${d.unit}${d.subSection ? ` / ${d.subSection}` : ''}`);
  res.status(201).json({ demand: await Demand.findById(d._id).populate('lines.item', ITEM_FIELDS).lean() });
});

router.put('/:id', canWrite, validate(idParam, 'params'), validate(body), async (req, res) => {
  const lines = await checkItems(req.valid.body.lines);
  const d = await Demand.findByIdAndUpdate(req.valid.params.id, { $set: { ...req.valid.body, lines } }, { returnDocument: 'after', runValidators: true })
    .populate('lines.item', ITEM_FIELDS)
    .lean();
  if (!d) throw notFound('Demand not found');
  await audit(req, 'UPDATE', 'Demand', d._id, `Demand ${d.demandNo} updated`);
  res.json({ demand: d });
});

router.delete('/:id', adminOnly, validate(idParam, 'params'), async (req, res) => {
  const d = await Demand.findByIdAndDelete(req.valid.params.id);
  if (!d) throw notFound('Demand not found');
  await audit(req, 'DELETE', 'Demand', d._id, `Deleted demand ${d.demandNo}`);
  res.json({ ok: true });
});

export default router;
