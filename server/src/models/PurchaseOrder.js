import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

const orderLine = new mongoose.Schema(
  {
    description: { type: String, required: true, trim: true },
    qty: { type: Number, default: 0, min: 0 },
    uom: { type: String, default: '' },
    rate: { type: Number, default: 0, min: 0 },
    amount: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);

/**
 * Purchase order record (GeM or other sources): demand, approval, order, delivery, bill and payment.
 * Stand-alone — it never posts stock or appears in the store / ledger reports; only in the Order Report.
 */
const purchaseOrderSchema = new mongoose.Schema(
  {
    orderNo: { type: String, required: true, unique: true }, // ORD-000001
    mode: { type: String, required: true }, // GeM / Local Purchase / Tender …
    supplyOrderNo: { type: String, default: '', trim: true }, // Supply Order / GeM Contract No.
    gemOrderId: { type: String, default: '', trim: true },
    orderDate: { type: Date, required: true },
    vendor: { type: String, required: true, trim: true },
    vendorGstin: { type: String, default: '', trim: true },
    // Demand
    demandNo: { type: String, default: '', trim: true },
    demandDate: Date,
    demandFrom: { type: String, default: '', trim: true }, // demanding unit / section
    // Approval of the Commander / CFA
    approvalDate: Date,
    approvedBy: { type: String, default: '', trim: true },
    notingNo: { type: String, default: '', trim: true },
    notingDate: Date,
    // Funds
    codeHead: { type: String, default: '' },
    projectOffice: { type: String, default: '' }, // only for the "Project contingency" code head
    budgetYear: { type: String, default: '' },
    ledger: { type: String, default: '' }, // reference only
    lines: { type: [orderLine], default: [] },
    orderValue: { type: Number, default: 0 },
    // Delivery (reference only — stock is still taken on charge on the Receipt page)
    expectedDelivery: Date,
    deliveredOn: Date,
    receiptRef: { type: String, default: '', trim: true }, // CRV / receipt voucher reference
    // Bill → Accounts Office
    billNo: { type: String, default: '', trim: true },
    billDate: Date,
    billAmount: { type: Number, default: 0 },
    billForwardedOn: Date,
    accountsOffice: { type: String, default: '', trim: true }, // e.g. PCDA / CDA / PAO
    forwardingLetterNo: { type: String, default: '', trim: true },
    // Payment
    paymentDate: Date,
    paymentAmount: { type: Number, default: 0 },
    paymentRef: { type: String, default: '', trim: true }, // DV / cheque / e-payment no.
    cancelled: { type: Boolean, default: false },
    remarks: { type: String, default: '' },
    createdBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
purchaseOrderSchema.index({ orderDate: -1 });

/** Status from what has been recorded: Ordered → Delivered → Bill Forwarded → Paid (or Cancelled). */
export function orderStatus(o) {
  if (o.cancelled) return 'CANCELLED';
  if (o.paymentDate) return 'PAID';
  if (o.billForwardedOn) return 'BILL_FORWARDED';
  if (o.deliveredOn) return 'DELIVERED';
  return 'ORDERED';
}

export const PurchaseOrder = mongoose.model('PurchaseOrder', purchaseOrderSchema);
