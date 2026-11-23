import mongoose from 'mongoose';

const itemSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, trim: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: '' },
    // Default Ledger Page No., pre-filled on Receipt / Issue lines for this item.
    ledgerPage: { type: String, trim: true, default: '' },
    ledger: { type: String, required: true }, // key of a ledger in Settings
    uom: { type: String, required: true, trim: true },
    // Informational: Consumable / Non-Consumable, shown in the Item Master.
    category: { type: String, enum: ['CONSUMABLE', 'NON_CONSUMABLE'], default: 'NON_CONSUMABLE' },
    minStock: { type: Number, min: 0, default: 0 },
    status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE' },
    // Cached current balance; the authoritative history lives in StockTxn.
    currentStock: { type: Number, default: 0, min: 0 },
    // Weighted average receipt rate, used to value issues.
    avgRate: { type: Number, default: 0, min: 0 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

itemSchema.index({ ledger: 1, name: 1 });
itemSchema.index({ name: 'text', description: 'text', code: 'text' });

export default mongoose.model('Item', itemSchema);
