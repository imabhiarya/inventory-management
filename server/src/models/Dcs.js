import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

const dcsLine = new mongoose.Schema(
  {
    nameOfWork: { type: String, default: '', trim: true },
    item: { type: ObjectId, ref: 'Item' }, // when picked from the Item Master (any ledger); the description stays editable
    description: { type: String, required: true, trim: true }, // description of item
    uom: { type: String, default: '', trim: true }, // A/U
    qty: { type: Number, default: 0, min: 0 },
    rate: { type: Number, default: 0, min: 0 },
    amount: { type: Number, default: 0, min: 0 }, // qty × rate
    remarks: { type: String, default: '' },
  },
  { _id: false },
);

/** A rate quotation (or other document) attached to the DCS; the bytes are in GridFS ("auditFiles"). */
const fileMeta = new mongoose.Schema(
  {
    fileId: { type: ObjectId, required: true },
    name: { type: String, required: true },
    type: { type: String, required: true },
    size: { type: Number, default: 0 },
    uploadedAt: { type: Date, default: Date.now },
    byName: { type: String, default: '' },
  },
  { _id: false },
);

/**
 * DCS: a typed statement of items for a job (unit, job no. and description, name of work, authority),
 * with rates and amounts, printed with the signature blocks set in Settings and backed by rate quotations.
 * A record for printing only — it never touches stock.
 */
const dcsSchema = new mongoose.Schema(
  {
    dcsNo: { type: String, required: true, unique: true }, // DCS-000001
    date: { type: Date, required: true },
    unit: { type: String, default: '', trim: true },
    jobNo: { type: String, default: '', trim: true },
    jobDescription: { type: String, default: '', trim: true },
    nameOfWork: { type: String, default: '', trim: true },
    authority: { type: String, default: '', trim: true },
    lines: { type: [dcsLine], validate: (v) => v.length > 0 },
    totalAmount: { type: Number, default: 0 },
    remarks: { type: String, default: '' },
    files: { type: [fileMeta], default: [] },
    createdBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
dcsSchema.index({ date: -1 });

export const Dcs = mongoose.model('Dcs', dcsSchema);
