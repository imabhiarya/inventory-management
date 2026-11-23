import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

/** A file attached to an observation or a reply; the bytes live in the GridFS bucket "auditFiles". */
const fileMeta = new mongoose.Schema(
  {
    fileId: { type: ObjectId, required: true },
    name: { type: String, required: true },
    type: { type: String, required: true }, // MIME type (from the allowed list, by extension)
    size: { type: Number, default: 0 },
    uploadedAt: { type: Date, default: Date.now },
    byName: { type: String, default: '' },
  },
  { _id: false },
);

const reply = new mongoose.Schema(
  {
    date: { type: Date, required: true },
    letterRef: { type: String, default: '', trim: true }, // our letter ref. no. for this reply
    text: { type: String, default: '' },
    by: { type: ObjectId, ref: 'User' },
    byName: { type: String, default: '' },
    files: { type: [fileMeta], default: [] },
  },
  { timestamps: true },
);

/**
 * Audit observation (LAO / Test Audit / CAG …) on the store's ledgers or vouchers, with the audit's own
 * documents attached, the store's replies, and a status: OPEN → REPLIED → SETTLED.
 */
const auditObservationSchema = new mongoose.Schema(
  {
    obsNo: { type: String, required: true, unique: true }, // AO-000001
    office: { type: String, required: true, trim: true }, // audit office (LAO, CAG …)
    team: { type: String, default: '', trim: true }, // team / officer
    auditPeriod: { type: String, default: '', trim: true },
    paraNo: { type: String, default: '', trim: true },
    letterNo: { type: String, default: '', trim: true }, // audit office's letter that raised the observation
    letterDate: Date,
    date: { type: Date, required: true }, // date of the observation
    ledger: { type: String, default: '' }, // ledger key, optional
    reference: { type: String, default: '', trim: true }, // voucher no. / item / ledger page referred to
    subject: { type: String, required: true, trim: true },
    observation: { type: String, default: '' },
    status: { type: String, enum: ['OPEN', 'REPLIED', 'SETTLED'], default: 'OPEN' },
    settledOn: Date,
    files: { type: [fileMeta], default: [] },
    replies: { type: [reply], default: [] },
    createdBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
auditObservationSchema.index({ date: -1 });
auditObservationSchema.index({ 'files.fileId': 1 });
auditObservationSchema.index({ 'replies.files.fileId': 1 });

export const AuditObservation = mongoose.model('AuditObservation', auditObservationSchema);
