import { Router } from 'express';
import { z } from 'zod';
import {
  Settings,
  Counter,
  getSettings,
  audit,
  usableLedgers,
  ledgerGroups,
  isGroupLedger,
  INDENT_COUNTER,
  DEFAULT_INDENT_PREFIX,
} from '../models/misc.js';
import { Issue } from '../models/Voucher.js';
import Item from '../models/Item.js';
import { adminOnly, canWrite } from '../middleware/auth.js';
import { validate, zLedgerKey } from '../middleware/validate.js';
import { LOAN_LEDGER } from '../config/constants.js';
import { fyLabel, today } from '../utils/dates.js';
import { badRequest, conflict, notFound, escapeRegex } from '../utils/httpError.js';

const router = Router();

router.get('/', async (req, res) => {
  const settings = await getSettings();
  delete settings.__v;
  const t = today();
  res.json({
    settings,
    // `ledgers`: the ledgers items and vouchers use (sub-ledgers included, group ledgers left out).
    // `ledgerGroups`: group ledgers with their sub-ledger keys; `allLedgers`: everything, for Settings.
    ledgers: usableLedgers(settings.ledgers),
    ledgerGroups: ledgerGroups(settings.ledgers),
    allLedgers: settings.ledgers,
    today: t.toISOString().slice(0, 10),
    currentFy: fyLabel(t),
  });
});

const list = z
  .array(z.string().trim().min(1).max(120))
  .max(500)
  .transform((a) => [...new Set(a)]);

router.put(
  '/',
  adminOnly,
  validate(
    z.object({
      orgTitle: z.string().trim().min(1).max(80),
      orgSubtitle: z.string().trim().max(120),
      storeName: z.string().trim().min(1).max(120),
      station: z.string().trim().max(120),
      storeInCharge: z.string().trim().max(120),
      units: list,
      sources: list,
      receiptTypes: list.refine((a) => a.length > 0, 'At least one receipt type is required'),
      issueTypes: list.refine((a) => a.length > 0, 'At least one issue type is required'),
      loanTypes: list,
      otherOffices: list.optional(),
      storeTypes: list.optional(),
      auditOffices: list.optional(),
      loanStoreTypes: list.optional(),
      procurementModes: list.optional(),
      orderApprovers: list.optional(),
      orderAccountsOffices: list.optional(),
      orderDemandFrom: list.optional(),
      orderCodeHeads: list.optional(),
      orderUoms: list.optional(),
      orderProjectOffices: list.optional(),
      demandSubSections: list.optional(),
      demandFrequencies: list.optional(),
      demandAuthorities: list.optional(),
      dcsTitle: z.string().trim().min(1, 'Enter the DCS heading').max(120).optional(),
      dcsSignatures: z
        .array(
          z.object({
            title: z.string().trim().min(1, 'Each signature block needs a title (e.g. Prepared By)').max(80),
            name: z.string().trim().max(120).optional().default(''),
            designation: z.string().trim().max(120).optional().default(''),
          }),
        )
        .max(8, 'At most 8 signature blocks')
        .optional(),
      uoms: list.refine((a) => a.length > 0, 'At least one unit of measure is required'),
      codeHeads: z.array(z.object({ code: z.string().trim().min(1).max(20), name: z.string().trim().max(120) })).max(500),
    }),
  ),
  async (req, res) => {
    const settings = await Settings.findOneAndUpdate(
      { _id: 'app' },
      { $set: req.valid.body },
      { upsert: true, returnDocument: 'after' },
    ).lean();
    await audit(req, 'UPDATE', 'Settings', 'app', 'Updated settings');
    res.json({ settings });
  },
);

const sameText = (a, b) => a.toLowerCase() === b.toLowerCase();

// ---------- Stock Indent numbering (issues from sub-ledgers, e.g. Maint Store → B&R / E&M) ----------

/** Highest Stock Indent number already used with `prefix` (0 if none). */
async function lastIndentNo(prefix) {
  const rx = new RegExp(`^${escapeRegex(prefix)}(\\d+)$`);
  const used = await Issue.find({ issueNo: rx }, { issueNo: 1 }).lean();
  return used.reduce((max, v) => Math.max(max, Number(rx.exec(v.issueNo)[1])), 0);
}

async function indentInfo() {
  const prefix = (await getSettings()).stockIndent?.prefix || DEFAULT_INDENT_PREFIX;
  const seq = (await Counter.findById(INDENT_COUNTER).lean())?.seq || 0;
  return { prefix, nextNo: seq + 1, lastUsed: await lastIndentNo(prefix) };
}

router.get('/stock-indent', async (req, res) => {
  res.json(await indentInfo());
});

/** Change the Stock Indent prefix and/or the next number. The next number must be above any already used. */
router.put(
  '/stock-indent',
  adminOnly,
  validate(
    z.object({
      prefix: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z0-9/-]{1,12}$/, 'Prefix: 1–12 letters, digits, "/" or "-" (e.g. SI- or SI/MS/)'),
      nextNo: z.coerce.number().int().min(1, 'Next number must be 1 or more').max(999999),
    }),
  ),
  async (req, res) => {
    const { prefix, nextNo } = req.valid.body;
    const last = await lastIndentNo(prefix);
    if (nextNo <= last) throw conflict(`Stock Indent ${prefix}${String(last).padStart(6, '0')} already exists. The next number must be ${last + 1} or more.`);
    await Settings.updateOne({ _id: 'app' }, { $set: { 'stockIndent.prefix': prefix } });
    await Counter.updateOne({ _id: INDENT_COUNTER }, { $set: { seq: nextNo - 1 } }, { upsert: true });
    await audit(req, 'UPDATE', 'Settings', 'stock-indent', `Stock Indent numbering set to ${prefix}${String(nextNo).padStart(6, '0')} onwards`);
    res.json(await indentInfo());
  },
);

// ---------- Short lists managed from the Loan From Other Sources form ----------
// Store keepers can add or remove these while entering a loan, so they are not admin-only.
const QUICK_LISTS = [
  { path: 'other-offices', field: 'otherOffices', label: 'Office', entity: 'OtherOffice' },
  { path: 'store-types', field: 'storeTypes', label: 'Type of store', entity: 'StoreType' },
];

for (const { path, field, label, entity } of QUICK_LISTS) {
  const nameBody = z.object({ name: z.string().trim().min(2, `${label} name is required`).max(120) });

  router.post(`/${path}`, canWrite, validate(nameBody), async (req, res) => {
    const { name } = req.valid.body;
    const current = (await getSettings())[field] || [];
    if (current.some((o) => sameText(o, name))) throw conflict(`${name} is already in the list`);
    const updated = await Settings.findOneAndUpdate({ _id: 'app' }, { $addToSet: { [field]: name } }, { returnDocument: 'after' }).lean();
    await audit(req, 'CREATE', entity, name, `Added ${label.toLowerCase()} ${name}`);
    res.status(201).json({ [field]: updated[field] });
  });

  router.delete(`/${path}/:name`, canWrite, validate(nameBody, 'params'), async (req, res) => {
    const { name } = req.valid.params;
    const updated = await Settings.findOneAndUpdate({ _id: 'app' }, { $pull: { [field]: name } }, { returnDocument: 'after' }).lean();
    await audit(req, 'DELETE', entity, name, `Removed ${label.toLowerCase()} ${name}`);
    res.json({ [field]: updated[field] || [] });
  });
}

// ---------- Ledgers (Type of Store / Ledger) ----------

const ledgerLabel = z
  .string()
  .trim()
  .min(2, 'Ledger name is required')
  .max(60)
  // "Electrical" → "Electrical Ledger", so all ledgers read consistently.
  .transform((v) => (/ledger$/i.test(v) ? v : `${v} Ledger`));
const ledgerPrefix = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2,4}$/, 'Code prefix must be 2–4 letters (e.g. EL)');

/**
 * Add a ledger. Its key is derived from the name; the prefix is used for item codes (e.g. EL-0001).
 * With `parent`, it is added as a sub-ledger of that ledger (one level only), which then becomes a group.
 */
router.post(
  '/ledgers',
  adminOnly,
  validate(z.object({ label: ledgerLabel, prefix: ledgerPrefix, parent: zLedgerKey.optional() })),
  async (req, res) => {
    const { label, prefix, parent } = req.valid.body;
    const { ledgers } = await getSettings();
    if (ledgers.some((l) => sameText(l.label, label))) throw conflict(`A ledger named "${label}" already exists`);
    if (ledgers.some((l) => l.prefix === prefix)) throw conflict(`Code prefix ${prefix} is already used by another ledger`);
    if (parent) {
      const group = ledgers.find((l) => l.key === parent);
      if (!group) throw notFound('Parent ledger not found');
      if (group.parent) throw badRequest('Sub-ledgers cannot have sub-ledgers of their own');
      if (parent === LOAN_LEDGER) throw badRequest('The Loan Store Ledger cannot have sub-ledgers');
      // Turning a ledger into a group: its own items would have no usable ledger any more.
      if (!isGroupLedger(ledgers, parent)) {
        const count = await Item.countDocuments({ ledger: parent });
        if (count) throw conflict(`${group.label} already has ${count} item(s) registered, so it cannot be divided into sub-ledgers`);
      }
    }

    const base =
      label
        .replace(/ledger$/i, '')
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '_')
        .replace(/^_|_$/g, '')
        .slice(0, 30) || prefix;
    let key = base;
    for (let n = 2; ledgers.some((l) => l.key === key); n++) key = `${base}_${n}`;

    const ledger = parent ? { key, label, prefix, parent } : { key, label, prefix };
    // Conditional push guards against two admins adding the same prefix at once.
    const updated = await Settings.findOneAndUpdate(
      { _id: 'app', 'ledgers.prefix': { $ne: prefix }, 'ledgers.key': { $ne: key } },
      { $push: { ledgers: ledger } },
      { returnDocument: 'after' },
    ).lean();
    if (!updated) throw conflict('That ledger was just added by someone else. Refresh and try again.');
    await audit(req, 'CREATE', 'Ledger', key, `Added ledger ${label} (${prefix})${parent ? ` under ${parent}` : ''}`);
    res.status(201).json({ ledger, ledgers: updated.ledgers });
  },
);

/** Rename a ledger (its key and code prefix stay the same, so existing item codes remain valid). */
router.patch(
  '/ledgers/:key',
  adminOnly,
  validate(z.object({ key: zLedgerKey }), 'params'),
  validate(z.object({ label: ledgerLabel })),
  async (req, res) => {
    const { key } = req.valid.params;
    const { label } = req.valid.body;
    const { ledgers } = await getSettings();
    if (!ledgers.some((l) => l.key === key)) throw notFound('Ledger not found');
    if (ledgers.some((l) => l.key !== key && sameText(l.label, label))) throw conflict(`A ledger named "${label}" already exists`);
    const updated = await Settings.findOneAndUpdate(
      { _id: 'app', 'ledgers.key': key },
      { $set: { 'ledgers.$.label': label } },
      { returnDocument: 'after' },
    ).lean();
    await audit(req, 'UPDATE', 'Ledger', key, `Renamed ledger to ${label}`);
    res.json({ ledgers: updated.ledgers });
  },
);

/** Remove a ledger that has no items registered in it. */
router.delete('/ledgers/:key', adminOnly, validate(z.object({ key: zLedgerKey }), 'params'), async (req, res) => {
  const { key } = req.valid.params;
  if (key === LOAN_LEDGER) throw badRequest('The Loan Store Ledger is used by the Loan Store module and cannot be removed');
  const { ledgers } = await getSettings();
  const ledger = ledgers.find((l) => l.key === key);
  if (!ledger) throw notFound('Ledger not found');
  if (isGroupLedger(ledgers, key)) throw conflict(`${ledger.label} has sub-ledgers. Remove them first.`);
  const count = await Item.countDocuments({ ledger: key });
  if (count) throw conflict(`${ledger.label} has ${count} item(s) registered and cannot be removed`);
  const updated = await Settings.findOneAndUpdate({ _id: 'app' }, { $pull: { ledgers: { key } } }, { returnDocument: 'after' }).lean();
  await audit(req, 'DELETE', 'Ledger', key, `Removed ledger ${ledger.label}`);
  res.json({ ledgers: updated.ledgers });
});

export default router;
