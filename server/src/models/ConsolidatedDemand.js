import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

/** Who asked for how much of an item (from the section demands that were combined). */
const share = new mongoose.Schema(
  { demandNo: String, unit: String, subSection: String, qty: Number },
  { _id: false },
);

const line = new mongoose.Schema(
  {
    item: { type: ObjectId, ref: 'Item', required: true },
    qty: { type: Number, required: true, min: 0 }, // total (editable)
    rate: { type: Number, default: 0, min: 0 },
    remarks: { type: String, default: '' },
    breakdown: { type: [share], default: [] }, // empty for items added directly
  },
  { _id: false },
);

/**
 * Consolidated demand: the section demands combined into one list (items of any ledger) and forwarded
 * for procurement. A record for printing — it never changes stock.
 */
const consolidatedDemandSchema = new mongoose.Schema(
  {
    cdNo: { type: String, required: true, unique: true }, // CDM-000001
    date: { type: Date, required: true },
    forwardedTo: { type: String, default: '', trim: true },
    subject: { type: String, default: '', trim: true },
    frequency: { type: String, default: 'Regular' },
    codeHead: { type: String, default: '' }, // from the Orders code head list
    authority: { type: String, default: '', trim: true },
    remarks: { type: String, default: '' },
    sourceDemands: [{ type: ObjectId, ref: 'Demand' }],
    lines: { type: [line], validate: (v) => v.length > 0 },
    createdBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
consolidatedDemandSchema.index({ date: -1 });

export const ConsolidatedDemand = mongoose.model('ConsolidatedDemand', consolidatedDemandSchema);
