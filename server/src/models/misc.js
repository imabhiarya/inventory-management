import mongoose from 'mongoose';
import { DEFAULT_SETTINGS, DEFAULT_LEDGERS } from '../config/constants.js';
import { badRequest } from '../utils/httpError.js';

// Atomic sequence numbers for voucher / item codes.
const counterSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 },
});
export const Counter = mongoose.model('Counter', counterSchema);

export async function nextSeq(key, session) {
  const doc = await Counter.findOneAndUpdate(
    { _id: key },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after', session },
  );
  return doc.seq;
}

const settingsSchema = new mongoose.Schema(
  {
    _id: { type: String, default: 'app' },
    orgTitle: String,
    orgSubtitle: String,
    storeName: String,
    station: String,
    storeInCharge: String,
    units: [String],
    sources: [String],
    receiptTypes: [String],
    issueTypes: [String],
    loanTypes: [String],
    storeTypes: [String], // Type of Store on Loan From Other Sources vouchers
    otherOffices: [String], // offices items are taken on loan from (Loan From Other Sources)
    uoms: [String],
    auditOffices: [String], // audit parties for Audit Observations (LAO, Test Audit, CAG …)
    loanStoreTypes: [String], // Type of Loan Store (Furniture Store, T&P Store …) for Loan Store Ledger vouchers
    // Orders page drop-downs, edited separately from the store lists.
    procurementModes: [String], // GeM / Local Purchase / Tender …
    orderApprovers: [String],
    orderAccountsOffices: [String],
    orderDemandFrom: [String],
    orderCodeHeads: [String],
    orderUoms: [String],
    orderProjectOffices: [String], // Office drop-down shown for the "Project contingency" code head
    demandSubSections: [String], // Demand page
    demandFrequencies: [String], // Demand page
    demandAuthorities: [String], // Demand page
    codeHeads: [{ _id: false, code: String, name: String }],
    // `parent`: key of the group ledger this one sits under (e.g. B&R / E&M Store Ledger under Maint Store).
    ledgers: [{ _id: false, key: String, label: String, prefix: String, parent: String }],
    // Issues from sub-ledgers (e.g. Maint Store → B&R / E&M) are Stock Indents with their own number series.
    stockIndent: { prefix: { type: String, default: 'SI-' } },
  },
  { timestamps: true },
);
export const Settings = mongoose.model('Settings', settingsSchema);

export async function getSettings() {
  const doc = await Settings.findById('app').lean();
  // Databases created before these lists existed: add their defaults once.
  // Orders lists start as copies of the matching store lists, then are edited separately.
  const initial = {
    orderDemandFrom: (d) => d.units || [],
    orderCodeHeads: (d) => (d.codeHeads || []).map((c) => (c.name ? `${c.code} – ${c.name}` : c.code)),
    orderUoms: (d) => d.uoms || [],
    orderProjectOffices: (d) => [d.station, ...(d.units || [])].filter(Boolean),
  };
  for (const key of ['auditOffices', 'loanStoreTypes', 'procurementModes', 'orderApprovers', 'orderAccountsOffices', 'orderProjectOffices', 'demandSubSections', 'demandAuthorities', 'demandFrequencies', ...Object.keys(initial)]) {
    if (doc && !doc[key]) {
      const value = initial[key] ? initial[key](doc) : DEFAULT_SETTINGS[key];
      await Settings.updateOne({ _id: 'app', [key]: { $exists: false } }, { $set: { [key]: value } });
      doc[key] = value;
    }
  }
  if (doc?.ledgers?.length) return doc;
  if (doc) {
    // Databases created before ledgers became configurable: add the defaults.
    return Settings.findOneAndUpdate({ _id: 'app' }, { $set: { ledgers: DEFAULT_LEDGERS } }, { returnDocument: 'after' }).lean();
  }
  return (await Settings.findOneAndUpdate({ _id: 'app' }, { $setOnInsert: DEFAULT_SETTINGS }, { upsert: true, returnDocument: 'after' })).toObject();
}

/** A group ledger is one that has sub-ledgers; it holds no items or vouchers itself. */
export const isGroupLedger = (ledgers, key) => ledgers.some((l) => l.parent === key);

/** Ledgers that hold items and vouchers: every ledger except groups (so reports list sub-ledgers individually). */
export const usableLedgers = (ledgers) => ledgers.filter((l) => !isGroupLedger(ledgers, l.key));

/** Group ledgers with their sub-ledger keys, in settings order. */
export const ledgerGroups = (ledgers) =>
  ledgers
    .filter((l) => isGroupLedger(ledgers, l.key))
    .map((g) => ({ ...g, children: ledgers.filter((l) => l.parent === g.key).map((l) => l.key) }));

/** Counter key and default prefix of the Stock Indent number series. */
export const INDENT_COUNTER = 'issue-indent';
export const DEFAULT_INDENT_PREFIX = 'SI-';

/** Issues from a sub-ledger (one with a parent group, e.g. B&R / E&M under Maint Store) are Stock Indents. */
export async function isIndentLedger(key) {
  const all = (await getSettings()).ledgers;
  return !!all.find((l) => l.key === key)?.parent;
}

/** Ledgers items and vouchers can belong to (group ledgers excluded). */
export async function getLedgers() {
  return usableLedgers((await getSettings()).ledgers);
}

/** Returns the ledger config for `key`, or throws 400 if it does not exist or is a group. */
export async function requireLedger(key) {
  const all = (await getSettings()).ledgers;
  const ledger = all.find((l) => l.key === key);
  if (!ledger) throw badRequest('Unknown ledger. Add it under Settings → Ledgers first.');
  if (isGroupLedger(all, key)) {
    const names = all.filter((l) => l.parent === key).map((l) => l.label);
    throw badRequest(`${ledger.label} is divided into sub-ledgers. Choose one: ${names.join(', ')}.`);
  }
  return ledger;
}

const auditSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    username: String,
    action: { type: String, required: true },
    entity: String,
    entityId: String,
    summary: String,
    ip: String,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
auditSchema.index({ createdAt: -1 });
export const AuditLog = mongoose.model('AuditLog', auditSchema);

export async function audit(req, action, entity, entityId, summary, session) {
  await AuditLog.create(
    [
      {
        user: req.user?._id,
        username: req.user?.username,
        action,
        entity,
        entityId: entityId?.toString(),
        summary,
        ip: req.ip,
      },
    ],
    { session },
  );
}
