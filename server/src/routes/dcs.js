import { Router } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { Dcs } from '../models/Dcs.js';
import { nextSeq, audit } from '../models/misc.js';
import { canWrite, adminOnly } from '../middleware/auth.js';
import { validate, idParam, zId, zDay, zText, zReqText } from '../middleware/validate.js';
import { notFound, escapeRegex, round2, round3 } from '../utils/httpError.js';
import { pad6, peekNextNo } from '../services/vouchers.js';
import { storeFile, dropFiles, sendFile } from '../services/files.js';

const router = Router();

const body = z
  .object({
    date: zDay,
    unit: zText(160).optional().default(''),
    jobNo: zText(80).optional().default(''),
    jobDescription: zText(1000).optional().default(''),
    nameOfWork: zText(500).optional().default(''),
    authority: zText(300).optional().default(''),
    remarks: zText(1000).optional().default(''),
    lines: z
      .array(
        z.object({
          nameOfWork: zText(500).optional().default(''),
          item: zId.optional(),
          description: zReqText('Description of item', 1000),
          uom: zText(30).optional().default(''),
          qty: z.coerce.number().min(0).max(1e9).default(0),
          rate: z.coerce.number().min(0).max(1e12).default(0),
          remarks: zText(300).optional().default(''),
        }),
      )
      .min(1, 'Add at least one item')
      .max(300),
  })
  .transform((b) => {
    const lines = b.lines.map((l) => ({ ...l, qty: round3(l.qty), rate: round2(l.rate), amount: round2(l.qty * l.rate) }));
    return { ...b, lines, totalAmount: round2(lines.reduce((s, l) => s + l.amount, 0)) };
  });

const listQuery = z.object({
  from: zDay.optional().or(z.literal('').transform(() => undefined)),
  to: zDay.optional().or(z.literal('').transform(() => undefined)),
  q: zText(100).optional(),
});

router.get('/', validate(listQuery, 'query'), async (req, res) => {
  const { from, to, q } = req.valid.query;
  const filter = {};
  if (from || to) filter.date = { ...(from && { $gte: from }), ...(to && { $lte: to }) };
  if (q) {
    const rx = new RegExp(escapeRegex(q), 'i');
    filter.$or = ['dcsNo', 'unit', 'jobNo', 'jobDescription', 'nameOfWork', 'authority', 'lines.description', 'lines.nameOfWork'].map((f) => ({ [f]: rx }));
  }
  res.json({ rows: await Dcs.find(filter).sort({ date: -1, createdAt: -1 }).limit(500).lean() });
});

router.get('/next-no', async (req, res) => {
  res.json({ next: await peekNextNo('dcs', 'DCS-') });
});

/** Open / download an attached quotation. Only files that belong to a DCS are served. */
router.get('/files/:fileId', validate(z.object({ fileId: zId }), 'params'), async (req, res) => {
  const id = new mongoose.Types.ObjectId(req.valid.params.fileId);
  const d = await Dcs.findOne({ 'files.fileId': id }).lean();
  if (!d) throw notFound('File not found');
  sendFile(req, res, d.files.find((f) => f.fileId.equals(id)));
});

router.get('/:id', validate(idParam, 'params'), async (req, res) => {
  const d = await Dcs.findById(req.valid.params.id).lean();
  if (!d) throw notFound('DCS not found');
  res.json({ dcs: d });
});

router.post('/', canWrite, validate(body), async (req, res) => {
  const d = await Dcs.create({ ...req.valid.body, dcsNo: `DCS-${pad6(await nextSeq('dcs'))}`, createdBy: req.user._id });
  await audit(req, 'CREATE', 'Dcs', d._id, `DCS ${d.dcsNo}${d.jobNo ? ` (Job ${d.jobNo})` : ''}`);
  res.status(201).json({ dcs: d.toObject() });
});

router.put('/:id', canWrite, validate(idParam, 'params'), validate(body), async (req, res) => {
  const d = await Dcs.findByIdAndUpdate(req.valid.params.id, { $set: req.valid.body }, { returnDocument: 'after', runValidators: true }).lean();
  if (!d) throw notFound('DCS not found');
  await audit(req, 'UPDATE', 'Dcs', d._id, `DCS ${d.dcsNo} updated`);
  res.json({ dcs: d });
});

router.delete('/:id', adminOnly, validate(idParam, 'params'), async (req, res) => {
  const d = await Dcs.findByIdAndDelete(req.valid.params.id);
  if (!d) throw notFound('DCS not found');
  await dropFiles(d.files);
  await audit(req, 'DELETE', 'Dcs', d._id, `Deleted DCS ${d.dcsNo}`);
  res.json({ ok: true });
});

// ---------- Rate quotations / documents ----------

router.post(
  '/:id/files',
  canWrite,
  validate(idParam, 'params'),
  validate(z.object({ name: zReqText('File name', 200), data: z.string().min(1) })),
  async (req, res) => {
    const { name, data } = req.valid.body;
    const d = await Dcs.findById(req.valid.params.id);
    if (!d) throw notFound('DCS not found');
    d.files.push(await storeFile(name, data, req.user.name || req.user.username));
    await d.save();
    await audit(req, 'UPDATE', 'Dcs', d._id, `Quotation "${name}" attached to DCS ${d.dcsNo}`);
    res.status(201).json({ dcs: d.toObject() });
  },
);

router.delete('/:id/files/:fileId', canWrite, validate(z.object({ id: zId, fileId: zId }), 'params'), async (req, res) => {
  const d = await Dcs.findById(req.valid.params.id);
  if (!d) throw notFound('DCS not found');
  const file = d.files.find((f) => f.fileId.toString() === req.valid.params.fileId);
  if (!file) throw notFound('File not found');
  d.files = d.files.filter((f) => f !== file);
  await d.save();
  await dropFiles([file]);
  await audit(req, 'UPDATE', 'Dcs', d._id, `File "${file.name}" removed from DCS ${d.dcsNo}`);
  res.json({ dcs: d.toObject() });
});

export default router;
