import mongoose from 'mongoose';
import { VOUCHER_TYPE_KEYS } from '../config/constants.js';

// One row per item movement. The Master Ledger is computed from these rows,
// so running balances are always correct even for back-dated or edited vouchers.
const stockTxnSchema = new mongoose.Schema(
  {
    date: { type: Date, required: true },
    item: { type: mongoose.Schema.Types.ObjectId, ref: 'Item', required: true },
    ledger: { type: String, required: true },
    voucherType: { type: String, enum: VOUCHER_TYPE_KEYS, required: true },
    voucherNo: { type: String, required: true },
    oldRvNo: { type: String, default: '' }, // receipts only: Old RV No. shown beside the voucher no.
    oldIvNo: { type: String, default: '' }, // issues only: Old IV No. shown beside the voucher no.
    voucherId: { type: mongoose.Schema.Types.ObjectId, required: true },
    receiptQty: { type: Number, default: 0, min: 0 },
    issueQty: { type: Number, default: 0, min: 0 },
    rate: { type: Number, default: 0, min: 0 },
    remarks: { type: String, default: '' },
    seq: { type: Number, default: 0 }, // line order within the voucher
  },
  { timestamps: true },
);

stockTxnSchema.index({ item: 1, date: 1, createdAt: 1 });
stockTxnSchema.index({ ledger: 1, date: 1 });
stockTxnSchema.index({ voucherId: 1 });

export default mongoose.model('StockTxn', stockTxnSchema);
