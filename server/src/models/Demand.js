import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

const demandLine = new mongoose.Schema(
  {
    item: { type: ObjectId, ref: 'Item', required: true },
    qty: { type: Number, required: true, min: 0 },
    rate: { type: Number, default: 0, min: 0 }, // optional; printed only when given
    remarks: { type: String, default: '' },
  },
  { _id: false },
);

/**
 * Demand (indent) raised by a unit / sub section for items of any ledger. A record for printing the
 * demand form — it never changes stock (items are issued on the Issue page).
 */
const demandSchema = new mongoose.Schema(
  {
    demandNo: { type: String, required: true, unique: true }, // DMD-000001
    date: { type: Date, required: true },
    unit: { type: String, required: true, trim: true },
    demandedTo: { type: String, default: '', trim: true }, // "To," on the printed demand (typed)
    frequency: { type: String, default: 'Regular' }, // Regular / Monthly / Quarterly …
    subSection: { type: String, default: '', trim: true },
    authority: { type: String, default: '', trim: true },
    remarks: { type: String, default: '' },
    lines: { type: [demandLine], validate: (v) => v.length > 0 },
    consolidatedIn: { id: { type: ObjectId, ref: 'ConsolidatedDemand' }, no: String }, // set when combined into a consolidated demand
    createdBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
demandSchema.index({ date: -1 });

export const Demand = mongoose.model('Demand', demandSchema);
