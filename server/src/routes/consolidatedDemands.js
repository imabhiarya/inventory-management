import { Router } from 'express';
import { z } from 'zod';
import { ConsolidatedDemand } from '../models/ConsolidatedDemand.js';
import { Demand } from '../models/Demand.js';
import Item from '../models/Item.js';
import { nextSeq, audit } from '../models/misc.js';
import { canWrite, adminOnly } from '../middleware/auth.js';
import { validate, idParam, zId, zDay, zText, zQty } from '../middleware/validate.js';
import { badRequest, notFound, round3 } from '../utils/httpError.js';
import { pad6, peekNextNo } from '../services/vouchers.js';

const router = Router();
const ITEM_FIELDS = 'code name description uom ledger currentStock';
const populate = (q) => q.populate('lines.item', ITEM_FIELDS).populate('sourceDemands', 'demandNo date unit subSection');

const body = z.object({
  date: zDay,
  forwardedTo: zText(200).optional().default(''),
  subject: zText(300).optional().default(''),
  frequency: zText(60).optional().default('Regular'),
  codeHead: zText(160).optional().default(''),
  authority: zText(160).optional().default(''),
  remarks: zText(500).optional().default(''),
  sourceDemands: z.array(zId).max(500).optional().default([]),
  lines: z
    .array(
      z.object({
        item: zId,
        qty: zQty,
        rate: z.coerce.number().min(0).max(1e12).optional().default(0),
        remarks: zText(200).optional().default(''),
        breakdown: z
          .array(z.object({ demandNo: zText(40), unit: zText(160), subSection: zText(120).optional().default(''), qty: z.coerce.number().min(0) }))
          .max(500)
          .optional()
          .default([]),
      }),
    )
    .min(1, 'Add at least one item')
    .max(500),
});

async function clean(data) {
  const ids = data.lines.map((l) => l.item);
  if (new Set(ids).size !== ids.length) throw badRequest('An item appears twice — combine the quantities');
  if ((await Item.countDocuments({ _id: { $in: ids } })) !== ids.length) throw badRequest('One or more items were not found');
  const sources = [...new Set(data.sourceDemands)];
  if ((await Demand.countDocuments({ _id: { $in: sources } })) !== sources.length) throw badRequest('One or more section demands were not found');
  return { ...data, sourceDemands: sources, lines: data.lines.map((l) => ({ ...l, qty: round3(l.qty), rate: Math.round((l.rate || 0) * 100) / 100 })) };
}

/** Mark the section demands as consolidated in `cd` (and un-mark those no longer included). */
async function linkSources(cd, previous = []) {
  const now = cd.sourceDemands.map(String);
  const dropped = previous.map(String).filter((id) => !now.includes(id));
  if (dropped.length) await Demand.updateMany({ _id: { $in: dropped }, 'consolidatedIn.id': cd._id }, { $unset: { consolidatedIn: 1 } });
  if (now.length) await Demand.updateMany({ _id: { $in: now } }, { $set: { consolidatedIn: { id: cd._id, no: cd.cdNo } } });
}

router.get('/', async (req, res) => {
  res.json({ rows: await populate(ConsolidatedDemand.find().sort({ date: -1, createdAt: -1 }).limit(500)).lean() });
});

router.get('/next-no', async (req, res) => {
  res.json({ next: await peekNextNo('consolidated-demand', 'CDM-') });
});

router.get('/:id', validate(idParam, 'params'), async (req, res) => {
  const cd = await populate(ConsolidatedDemand.findById(req.valid.params.id)).lean();
  if (!cd) throw notFound('Consolidated demand not found');
  res.json({ consolidated: cd });
});

router.post('/', canWrite, validate(body), async (req, res) => {
  const data = await clean(req.valid.body);
  const cd = await ConsolidatedDemand.create({ ...data, cdNo: `CDM-${pad6(await nextSeq('consolidated-demand'))}`, createdBy: req.user._id });
  await linkSources(cd);
  await audit(req, 'CREATE', 'ConsolidatedDemand', cd._id, `Consolidated demand ${cd.cdNo} (${cd.sourceDemands.length} section demands, ${cd.lines.length} items)`);
  res.status(201).json({ consolidated: await populate(ConsolidatedDemand.findById(cd._id)).lean() });
});

router.put('/:id', canWrite, validate(idParam, 'params'), validate(body), async (req, res) => {
  const data = await clean(req.valid.body);
  const before = await ConsolidatedDemand.findById(req.valid.params.id).lean();
  if (!before) throw notFound('Consolidated demand not found');
  const cd = await ConsolidatedDemand.findByIdAndUpdate(before._id, { $set: data }, { returnDocument: 'after', runValidators: true });
  await linkSources(cd, before.sourceDemands);
  await audit(req, 'UPDATE', 'ConsolidatedDemand', cd._id, `Consolidated demand ${cd.cdNo} updated`);
  res.json({ consolidated: await populate(ConsolidatedDemand.findById(cd._id)).lean() });
});

router.delete('/:id', adminOnly, validate(idParam, 'params'), async (req, res) => {
  const cd = await ConsolidatedDemand.findByIdAndDelete(req.valid.params.id);
  if (!cd) throw notFound('Consolidated demand not found');
  await Demand.updateMany({ 'consolidatedIn.id': cd._id }, { $unset: { consolidatedIn: 1 } });
  await audit(req, 'DELETE', 'ConsolidatedDemand', cd._id, `Deleted consolidated demand ${cd.cdNo}`);
  res.json({ ok: true });
});

export default router;
