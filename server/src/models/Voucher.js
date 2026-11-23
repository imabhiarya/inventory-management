import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

const audit = {
  status: { type: String, enum: ['POSTED', 'CANCELLED'], default: 'POSTED' },
  fy: { type: String, required: true },
  createdBy: { type: ObjectId, ref: 'User' },
  updatedBy: { type: ObjectId, ref: 'User' },
  cancelledBy: { type: ObjectId, ref: 'User' },
  cancelledAt: Date,
  cancelReason: String,
};

const receiptLine = new mongoose.Schema(
  {
    item: { type: ObjectId, ref: 'Item', required: true },
    codeHead: { type: String, default: '' },
    qty: { type: Number, required: true, min: 0 },
    rate: { type: Number, default: 0, min: 0 },
    amount: { type: Number, default: 0, min: 0 },
    ledgerPageNo: { type: String, default: '' },
  },
  { _id: false },
);

const receiptSchema = new mongoose.Schema(
  {
    receiptNo: { type: String, required: true, unique: true },
    oldRvNo: { type: String, trim: true, default: '' }, // Old RV No., entered manually
    oldLedgerPage: { type: String, trim: true, default: '' }, // B/F receipts only: page in the old (manual) ledger
    date: { type: Date, required: true },
    receiptType: { type: String, required: true },
    ledger: { type: String, required: true }, // Type of Store / Ledger (key from Settings)
    loanStoreType: { type: String, default: '' }, // Loan Store Ledger only: Furniture Store / T&P Store / Other Items …
    source: { type: String, required: true },
    poNo: { type: String, default: '' }, // not used for Loan Store Ledger receipts
    poDate: Date, // date the PO / sanction was issued (required by the API; absent on older receipts)
    remarks: { type: String, default: '' },
    lines: { type: [receiptLine], validate: (v) => v.length > 0 },
    totalAmount: { type: Number, default: 0 },
    ...audit,
  },
  { timestamps: true },
);
receiptSchema.index({ date: -1 });

const issueLine = new mongoose.Schema(
  {
    item: { type: ObjectId, ref: 'Item', required: true },
    qty: { type: Number, required: true, min: 0 },
    rate: { type: Number, default: 0, min: 0 },
    amount: { type: Number, default: 0, min: 0 },
    ledgerPageNo: { type: String, default: '' },
    remarks: { type: String, default: '' },
  },
  { _id: false },
);

const issueSchema = new mongoose.Schema(
  {
    issueNo: { type: String, required: true, unique: true },
    oldIvNo: { type: String, trim: true, default: '' }, // Old IV No., entered manually
    date: { type: Date, required: true },
    issueType: { type: String, required: true },
    // REGULAR = one-off issue; MONTHLY = consolidated on the monthly Certified Issue Voucher.
    frequency: { type: String, enum: ['REGULAR', 'MONTHLY'], default: 'REGULAR' },
    civMonth: { type: String, default: '' }, // MONTHLY only: 'YYYY-MM' the issue is certified for on the CIV
    ledger: { type: String, required: true }, // Type of Store / Ledger (key from Settings)
    loanStoreType: { type: String, default: '' }, // Loan Store Ledger only: Furniture Store / T&P Store / Other Items …
    issueTo: { type: String, required: true },
    authorityRef: { type: String, required: true },
    remarks: { type: String, default: '' },
    lines: { type: [issueLine], validate: (v) => v.length > 0 },
    totalAmount: { type: Number, default: 0 },
    ...audit,
  },
  { timestamps: true },
);
issueSchema.index({ date: -1 });
issueSchema.index({ frequency: 1, civMonth: 1 });
issueSchema.index({ frequency: 1, date: 1 });

const loanLine = new mongoose.Schema(
  {
    item: { type: ObjectId, ref: 'Item', required: true },
    qty: { type: Number, required: true, min: 0 },
    returnedQty: { type: Number, default: 0, min: 0 }, // loan issue: returned by section; BORROW: deposited back to the office
    // Loan receipt / deposit: which loan issues / loans taken this quantity was set against (oldest first).
    allocations: { type: [{ _id: false, issue: { type: ObjectId, ref: 'LoanVoucher' }, qty: Number }], default: undefined },
    remarks: { type: String, default: '' },
  },
  { _id: false },
);

const loanSchema = new mongoose.Schema(
  {
    voucherNo: { type: String, required: true, unique: true },
    kind: { type: String, enum: ['ISSUE', 'RECEIPT', 'BORROW', 'DEPOSIT'], required: true }, // BORROW = loan taken from another office; DEPOSIT = returned to it
    // issueTo holds the office the items were received from for a BORROW voucher.
    date: { type: Date, required: true },
    issueTo: { type: String, required: true },
    loanType: { type: String, default: '' },
    reference: { type: String, default: '' },
    returnDueDate: Date,
    storeType: { type: String, default: '' }, // Store Entry (BORROW) only
    issuedToSection: { type: String, default: '' }, // older Store Entry vouchers only (no longer entered)
    qtrNo: { type: String, default: '' }, // Loan Issue: quarter number of the section / occupant
    // true once the voucher is recorded in the separate Loan Store Ledger (LoanTxn / LoanStock).
    loanLedger: { type: Boolean, default: false },
    // Loan From Other Sources: the loan receipt (from the other office) and the loan issue (to the
    // section) are saved together and point at each other; cancelling one cancels both.
    linkedVoucher: { type: ObjectId, ref: 'LoanVoucher' },
    remarks: { type: String, default: '' },
    // For a loan receipt: the loan issue being returned against.
    againstIssue: { type: ObjectId, ref: 'LoanVoucher' },
    // Loan issue: ISSUED → PARTIAL → RETURNED as sections return items.
    // Loan taken from an office (BORROW): set the same way as items are deposited back to it.
    returnStatus: { type: String, enum: ['ISSUED', 'PARTIAL', 'RETURNED', null], default: null },
    lines: { type: [loanLine], validate: (v) => v.length > 0 },
    ...audit,
  },
  { timestamps: true },
);
loanSchema.index({ date: -1 });
loanSchema.index({ kind: 1, returnStatus: 1 });

export const Receipt = mongoose.model('Receipt', receiptSchema);
export const Issue = mongoose.model('Issue', issueSchema);
export const LoanVoucher = mongoose.model('LoanVoucher', loanSchema);
