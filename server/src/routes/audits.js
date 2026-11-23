import { Router } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { AuditObservation } from '../models/AuditObservation.js';
import { nextSeq, audit } from '../models/misc.js';
import { canWrite, adminOnly } from '../middleware/auth.js';
import { validate, idParam, zId, zDay, zText, zReqText } from '../middleware/validate.js';
import { badRequest, notFound, escapeRegex } from '../utils/httpError.js';
import { pad6 } from '../services/vouchers.js';
import { storeFile, dropFiles, sendFile } from '../services/files.js';

const router = Router();

// Files: see services/files.js (GridFS bucket "auditFiles").
export { MAX_FILE_BYTES, ALLOWED_EXTENSIONS } from '../services/files.js';

const allFiles = (doc) => [...doc.files, ...doc.replies.flatMap((r) => r.files)];

// ---------- Observations ----------

const body = z.object({
  office: zReqText('Audit office', 80),
  team: zText(120).optional().default(''),
  auditPeriod: zText(80).optional().default(''),
  paraNo: zText(40).optional().default(''),
  letterNo: zText(120).optional().default(''),
  letterDate: zDay.optional().or(z.literal('').transform(() => undefined)),
  date: zDay,
  ledger: zText(40).optional().default(''),
  reference: zText(200).optional().default(''),
  subject: zReqText('Subject', 200),
  observation: zText(10000).optional().default(''),
});

const listQuery = z.object({
  office: zText(80).optional(),
  status: z.enum(['OPEN', 'REPLIED', 'SETTLED', '']).optional(),
  q: zText(100).optional(),
  from: zDay.optional().or(z.literal('').transform(() => undefined)),
  to: zDay.optional().or(z.literal('').transform(() => undefined)),
});

router.get('/', validate(listQuery, 'query'), async (req, res) => {
  const { office, status, q, from, to } = req.valid.query;
  const filter = {};
  if (office) filter.office = office;
  if (status) filter.status = status;
  if (from || to) filter.date = { ...(from && { $gte: from }), ...(to && { $lte: to }) };
  if (q) {
    const rx = new RegExp(escapeRegex(q), 'i');
    filter.$or = ['obsNo', 'subject', 'observation', 'paraNo', 'letterNo', 'reference', 'team', 'auditPeriod', 'replies.letterRef'].map((f) => ({ [f]: rx }));
  }
  const rows = await AuditObservation.find(filter).sort({ date: -1, createdAt: -1 }).limit(1000).lean();
  res.json({ rows });
});

router.get('/:id', validate(idParam, 'params'), async (req, res) => {
  const obs = await AuditObservation.findById(req.valid.params.id).lean();
  if (!obs) throw notFound('Observation not found');
  res.json({ observation: obs });
});

router.post('/', canWrite, validate(body), async (req, res) => {
  const obs = await AuditObservation.create({ ...req.valid.body, obsNo: `AO-${pad6(await nextSeq('audit'))}`, createdBy: req.user._id });
  await audit(req, 'CREATE', 'AuditObservation', obs._id, `Audit observation ${obs.obsNo} (${obs.office}) recorded`);
  res.status(201).json({ observation: obs });
});

router.put('/:id', canWrite, validate(idParam, 'params'), validate(body), async (req, res) => {
  const { letterDate, ...fields } = req.valid.body;
  const update = letterDate ? { $set: { ...fields, letterDate } } : { $set: fields, $unset: { letterDate: 1 } };
  const obs = await AuditObservation.findByIdAndUpdate(req.valid.params.id, update, { returnDocument: 'after', runValidators: true });
  if (!obs) throw notFound('Observation not found');
  await audit(req, 'UPDATE', 'AuditObservation', obs._id, `Audit observation ${obs.obsNo} edited`);
  res.json({ observation: obs });
});

router.delete('/:id', adminOnly, validate(idParam, 'params'), async (req, res) => {
  const obs = await AuditObservation.findById(req.valid.params.id);
  if (!obs) throw notFound('Observation not found');
  await dropFiles(allFiles(obs));
  await obs.deleteOne();
  await audit(req, 'DELETE', 'AuditObservation', obs._id, `Audit observation ${obs.obsNo} deleted`);
  res.json({ ok: true });
});

router.patch(
  '/:id/status',
  canWrite,
  validate(idParam, 'params'),
  validate(z.object({ status: z.enum(['OPEN', 'REPLIED', 'SETTLED']) })),
  async (req, res) => {
    const { status } = req.valid.body;
    const obs = await AuditObservation.findByIdAndUpdate(
      req.valid.params.id,
      status === 'SETTLED' ? { $set: { status, settledOn: new Date() } } : { $set: { status }, $unset: { settledOn: 1 } },
      { returnDocument: 'after' },
    );
    if (!obs) throw notFound('Observation not found');
    await audit(req, 'UPDATE', 'AuditObservation', obs._id, `Audit observation ${obs.obsNo} marked ${status}`);
    res.json({ observation: obs });
  },
);

// ---------- Replies ----------

router.post(
  '/:id/replies',
  canWrite,
  validate(idParam, 'params'),
  validate(z.object({ date: zDay, letterRef: zText(120).optional().default(''), text: zText(10000).optional().default('') })),
  async (req, res) => {
    const obs = await AuditObservation.findById(req.valid.params.id);
    if (!obs) throw notFound('Observation not found');
    obs.replies.push({ ...req.valid.body, by: req.user._id, byName: req.user.name || req.user.username });
    if (obs.status === 'OPEN') obs.status = 'REPLIED';
    await obs.save();
    await audit(req, 'UPDATE', 'AuditObservation', obs._id, `Reply added to audit observation ${obs.obsNo}`);
    res.status(201).json({ observation: obs, replyId: obs.replies.at(-1)._id });
  },
);

router.delete(
  '/:id/replies/:replyId',
  canWrite,
  validate(z.object({ id: zId, replyId: zId }), 'params'),
  async (req, res) => {
    const obs = await AuditObservation.findById(req.valid.params.id);
    if (!obs) throw notFound('Observation not found');
    const r = obs.replies.id(req.valid.params.replyId);
    if (!r) throw notFound('Reply not found');
    await dropFiles(r.files);
    r.deleteOne();
    await obs.save();
    await audit(req, 'UPDATE', 'AuditObservation', obs._id, `Reply removed from audit observation ${obs.obsNo}`);
    res.json({ observation: obs });
  },
);

// ---------- Attachments ----------

/** Attach one file (sent as base64 JSON) to the observation, or to one of its replies with `replyId`. */
router.post(
  '/:id/files',
  canWrite,
  validate(idParam, 'params'),
  validate(z.object({ name: zReqText('File name', 200), data: z.string().min(1), replyId: zId.optional() })),
  async (req, res) => {
    const { name, data, replyId } = req.valid.body;
    const obs = await AuditObservation.findById(req.valid.params.id);
    if (!obs) throw notFound('Observation not found');
    const target = replyId ? obs.replies.id(replyId) : obs;
    if (!target) throw notFound('Reply not found');
    const meta = await storeFile(name, data, req.user.name || req.user.username);
    target.files.push(meta);
    await obs.save();
    await audit(req, 'UPDATE', 'AuditObservation', obs._id, `File "${name}" attached to audit observation ${obs.obsNo}`);
    res.status(201).json({ observation: obs });
  },
);

router.delete('/:id/files/:fileId', canWrite, validate(z.object({ id: zId, fileId: zId }), 'params'), async (req, res) => {
  const obs = await AuditObservation.findById(req.valid.params.id);
  if (!obs) throw notFound('Observation not found');
  const { fileId } = req.valid.params;
  const owner = [obs, ...obs.replies].find((x) => x.files.some((f) => f.fileId.toString() === fileId));
  if (!owner) throw notFound('File not found');
  const file = owner.files.find((f) => f.fileId.toString() === fileId);
  owner.files = owner.files.filter((f) => f.fileId.toString() !== fileId);
  await obs.save();
  await dropFiles([file]);
  await audit(req, 'UPDATE', 'AuditObservation', obs._id, `File "${file.name}" removed from audit observation ${obs.obsNo}`);
  res.json({ observation: obs });
});

/** Open / download an attached file. Only files that belong to an observation are served. */
router.get('/files/:fileId', validate(z.object({ fileId: zId }), 'params'), async (req, res) => {
  const id = new mongoose.Types.ObjectId(req.valid.params.fileId);
  const obs = await AuditObservation.findOne({ $or: [{ 'files.fileId': id }, { 'replies.files.fileId': id }] }).lean();
  if (!obs) throw notFound('File not found');
  sendFile(req, res, allFiles(obs).find((f) => f.fileId.equals(id)));
});

export default router;
