import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

// The Loan Store keeps its own ledger, separate from the normal ledgers. Loan movements never
// change an item's normal stock (Item.currentStock / StockTxn), so any item from any ledger can be
// taken on loan from another unit and issued to sections.

export const LOAN_TXN_TYPES = {
  OPENING: 'Opening (carried over)',
  STORE_ENTRY: 'Store Entry',
  LOAN_ISSUE: 'Loan Issue',
  LOAN_RETURN: 'Loan Receipt',
  LOAN_DEPOSIT: 'Loan Deposit (to Office)',
  RECEIPT: 'Receipt Voucher', // Receipt page, Loan Store Ledger
  ISSUE: 'Issue Voucher', // Issue page, Loan Store Ledger
};

/** One row per item movement in the Loan Store Ledger. */
const loanTxnSchema = new mongoose.Schema(
  {
    date: { type: Date, required: true },
    item: { type: ObjectId, ref: 'Item', required: true },
    type: { type: String, enum: Object.keys(LOAN_TXN_TYPES), required: true },
    voucherNo: { type: String, default: '' },
    voucherId: { type: ObjectId },
    party: { type: String, default: '' }, // unit received from / section issued to or returned by
    inQty: { type: Number, default: 0, min: 0 },
    outQty: { type: Number, default: 0, min: 0 },
    remarks: { type: String, default: '' },
    storeType: { type: String, default: '' }, // Type of Loan Store (Furniture Store, T&P Store …), from Receipt / Issue
    seq: { type: Number, default: 0 },
  },
  { timestamps: true },
);
loanTxnSchema.index({ item: 1, date: 1, createdAt: 1 });
loanTxnSchema.index({ voucherId: 1 });
export const LoanTxn = mongoose.model('LoanTxn', loanTxnSchema);

/** Current Loan Store balance per item, kept in step with LoanTxn so stock checks are atomic. */
const loanStockSchema = new mongoose.Schema(
  {
    item: { type: ObjectId, ref: 'Item', required: true, unique: true },
    // Can go below zero: any item may be issued on loan, not only what came in by Store Entry.
    qty: { type: Number, default: 0 },
  },
  { timestamps: true },
);
export const LoanStock = mongoose.model('LoanStock', loanStockSchema);
