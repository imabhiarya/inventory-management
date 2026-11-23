import { Router } from 'express';
import { z } from 'zod';
import Item from '../models/Item.js';
import StockTxn from '../models/StockTxn.js';
import { LoanTxn } from '../models/Loan.js';
import { Receipt, Issue, LoanVoucher } from '../models/Voucher.js';
import { nextSeq, audit, requireLedger, getSettings, usableLedgers } from '../models/misc.js';
import { canWrite } from '../middleware/auth.js';
import { validate, idParam, zText, zLedgerKey, zOptLedgerKey } from '../middleware/validate.js';
import { conflict, notFound, escapeRegex } from '../utils/httpError.js';
import { withTxn } from '../services/stock.js';
import { withLoanBalances, isLowStock } from '../services/stockView.js';

const router = Router();

const listQuery = z.object({
  ledger: zOptLedgerKey,
  status: z.enum(['ACTIVE', 'INACTIVE']).optional().or(z.literal('').transform(() => undefined)),
  q: zText(100).optional(),
  lowStock: z.enum(['true', 'false']).optional(),
});

router.get('/', validate(listQuery, 'query'), async (req, res) => {
  const { ledger, status, q, lowStock } = req.valid.query;
  const filter = {};
  if (ledger) filter.ledger = ledger;
  if (status) filter.status = status;
  if (q) {
    const rx = new RegExp(escapeRegex(q), 'i');
    filter.$or = [{ name: rx }, { code: rx }, { description: rx }];
  }
  let items = await withLoanBalances(await Item.find(filter).sort({ ledger: 1, code: 1 }).lean());
  if (lowStock === 'true') items = items.filter(isLowStock);
  res.json({ items });
});

/* ---------- Import (from Excel / CSV / Word / text, read in the browser) ---------- */

const importBody = z.object({
  ledger: zOptLedgerKey, // ledger for rows that do not name one (the ledger open in Master Ledger)
  dryRun: z.boolean().optional().default(false),
  items: z
    .array(
      z.object({
        code: zText(30).optional().default(''),
        name: zText(150).optional().default(''),
        description: zText(500).optional().default(''),
        ledger: zText(120).optional().default(''), // key or label, e.g. "STATIONARY" / "Stationary Ledger"
        uom: zText(20).optional().default(''),
        ledgerPage: zText(30).optional().default(''),
        category: zText(40).optional().default(''),
        minStock: z.union([z.number(), z.string()]).optional(),
        status: zText(20).optional().default(''),
      }),
    )
    .min(1, 'No items found in the file')
    .max(5000),
});
const keyOf = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const toCategory = (v) => (!v ? undefined : /^(c|consum)/i.test(v.trim()) && !/non/i.test(v) ? 'CONSUMABLE' : 'NON_CONSUMABLE');
const toStatus = (v) => (!v ? undefined : /^in/i.test(v.trim()) ? 'INACTIVE' : 'ACTIVE');
const toMin = (v) => {
  const n = Number(String(v ?? '').replace(/,/g, ''));
  return v === undefined || v === '' || !Number.isFinite(n) || n < 0 ? undefined : n;
};

/**
 * Items from a file → new items, or updates to existing ones (never duplicates). An item matches an
 * existing one by Item Code, else by the same name + description in the same ledger. With dryRun the
 * plan is returned without saving. Stock is never changed here (it comes in through receipts / B/F).
 */
router.post('/import', canWrite, validate(importBody), async (req, res) => {
  const { items: rows, dryRun, ledger: defLedger } = req.valid.body;
  const all = (await getSettings()).ledgers;
  const usable = usableLedgers(all);
  const findLedger = (v) => {
    const k = keyOf(v);
    return usable.find((l) => keyOf(l.key) === k || keyOf(l.label) === k || keyOf(l.label.replace(/\s*ledger$/i, '')) === k);
  };
  const existing = await Item.find({}).lean();
  const byCode = new Map(existing.map((i) => [keyOf(i.code), i]));
  const byName = new Map(existing.map((i) => [`${i.ledger}|${keyOf(i.name)}|${keyOf(i.description)}`, i]));
  const seen = new Set();
  const plan = rows.map((r, index) => {
    const out = { index, name: r.name, code: r.code };
    const fail = (error) => ({ ...out, action: 'error', error });
    const byCodeMatch = r.code && byCode.get(keyOf(r.code));
    const ledger = r.ledger ? findLedger(r.ledger) : byCodeMatch ? { key: byCodeMatch.ledger } : usable.find((l) => l.key === defLedger);
    if (!ledger && !byCodeMatch) return fail(r.ledger ? `Unknown ledger "${r.ledger}"` : 'No ledger given');
    const match = byCodeMatch || byName.get(`${ledger.key}|${keyOf(r.name)}|${keyOf(r.description)}`);
    if (!match && !r.name) return fail('Item name is missing');
    const fileKey = match ? `id:${match._id}` : `${ledger.key}|${keyOf(r.name)}|${keyOf(r.description)}`;
    if (seen.has(fileKey)) return fail('Same item appears twice in the file');
    seen.add(fileKey);
    const fields = {
      name: r.name || undefined,
      description: r.description || undefined,
      uom: r.uom || undefined,
      ledgerPage: r.ledgerPage || undefined,
      category: toCategory(r.category),
      minStock: toMin(r.minStock),
      status: toStatus(r.status),
    };
    Object.keys(fields).forEach((k) => fields[k] === undefined && delete fields[k]);
    if (match) {
      const changes = Object.entries(fields).filter(([k, v]) => String(match[k] ?? '') !== String(v));
      const note = ledger && ledger.key !== match.ledger ? `ledger kept as ${match.ledger}` : '';
      return { ...out, ledger: match.ledger, id: match._id, code: match.code, name: match.name, action: changes.length ? 'update' : 'same', set: Object.fromEntries(changes), note };
    }
    return { ...out, ledger: ledger.key, action: 'create', set: { uom: 'Nos', ...fields } };
  });

  if (!dryRun) {
    await withTxn(async (session) => {
      for (const p of plan) {
        if (p.action === 'create') {
          const { prefix } = all.find((l) => l.key === p.ledger);
          const code = `${prefix}-${String(await nextSeq(`item-${prefix}`, session)).padStart(4, '0')}`;
          await Item.create([{ ...p.set, ledger: p.ledger, code, createdBy: req.user._id }], { session });
          p.code = code;
        } else if (p.action === 'update') {
          await Item.updateOne({ _id: p.id }, { $set: p.set }, { session, runValidators: true });
        }
      }
      const n = (a) => plan.filter((p) => p.action === a).length;
      await audit(req, 'IMPORT', 'Item', null, `Imported items: ${n('create')} new, ${n('update')} updated, ${n('error')} skipped`, session);
    });
  }
  res.json({ plan: plan.map(({ set, id, ...p }) => ({ ...p, uom: set?.uom })) });
});

router.get('/:id', validate(idParam, 'params'), async (req, res) => {
  const item = await Item.findById(req.valid.params.id).lean();
  if (!item) throw notFound('Item not found');
  res.json({ item: (await withLoanBalances([item]))[0] });
});

const baseFields = {
  name: z.string().trim().min(1, 'Item name is required').max(150),
  description: zText(500).optional().default(''),
  ledgerPage: zText(30).optional().default(''),
  ledger: zLedgerKey,
  uom: z.string().trim().min(1, 'UoM is required').max(20),
  category: z.enum(['CONSUMABLE', 'NON_CONSUMABLE']).default('NON_CONSUMABLE'),
  minStock: z.coerce.number().min(0).max(1e9).default(0),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
};

// New items start at zero stock; stock is brought in through a Receipt.
router.post('/', canWrite, validate(z.object(baseFields)), async (req, res) => {
  const data = req.valid.body;
  const { prefix } = await requireLedger(data.ledger);
  const item = await withTxn(async (session) => {
    const seq = await nextSeq(`item-${prefix}`, session);
    const [doc] = await Item.create(
      [{ ...data, code: `${prefix}-${String(seq).padStart(4, '0')}`, createdBy: req.user._id }],
      { session },
    );
    await audit(req, 'CREATE', 'Item', doc._id, `Registered ${doc.code} ${doc.name}`, session);
    return doc;
  });
  res.status(201).json({ item });
});

router.put(
  '/:id',
  canWrite,
  validate(idParam, 'params'),
  validate(z.object(baseFields)),
  async (req, res) => {
    const item = await Item.findById(req.valid.params.id);
    if (!item) throw notFound('Item not found');
    const data = req.valid.body;
    let newCode = null;
    if (data.ledger !== item.ledger) {
      // Allowed only while the item is unused (e.g. registered under the wrong ledger by mistake);
      // it then gets a fresh code in the new ledger, e.g. ST-0007 → LN-0005.
      const used = await Promise.all([
        StockTxn.exists({ item: item._id }),
        LoanTxn.exists({ item: item._id }),
        Receipt.exists({ 'lines.item': item._id }),
        Issue.exists({ 'lines.item': item._id }),
        LoanVoucher.exists({ 'lines.item': item._id }),
      ]);
      if (used.some(Boolean) || item.currentStock) {
        throw conflict(`${item.code} has already been used on vouchers, so its Type of Store / Ledger cannot be changed`);
      }
      newCode = (await requireLedger(data.ledger)).prefix;
    }
    // Record exactly what changed (e.g. "status: ACTIVE → INACTIVE") in the audit log.
    const changes = Object.entries(data)
      .filter(([k, v]) => String(item[k] ?? '') !== String(v ?? ''))
      .map(([k, v]) => `${k}: ${item[k] ?? ''} → ${v}`);
    Object.assign(item, data);
    const oldCode = item.code;
    await withTxn(async (session) => {
      if (newCode) {
        item.code = `${newCode}-${String(await nextSeq(`item-${newCode}`, session)).padStart(4, '0')}`;
        changes.push(`code: ${oldCode} → ${item.code}`);
      }
      await item.save({ session });
      const what = changes.length ? changes.join('; ') : 'no changes';
      await audit(req, 'UPDATE', 'Item', item._id, `Updated ${item.code} ${item.name} (${what})`, session);
    });
    res.json({ item });
  },
);

router.delete('/:id', canWrite, validate(idParam, 'params'), async (req, res) => {
  const item = await Item.findById(req.valid.params.id);
  if (!item) throw notFound('Item not found');
  if ((await StockTxn.exists({ item: item._id, voucherType: { $ne: 'OPENING' } })) || (await LoanTxn.exists({ item: item._id }))) {
    throw conflict(
      `${item.name} (${item.code}) is used on receipts, issues or loan vouchers, so it can never be deleted – its ledger history must be kept. ` +
        (item.status === 'INACTIVE'
          ? 'It is already Inactive, so it cannot be used on new vouchers.'
          : 'Set its status to Inactive to stop it being used on new vouchers.'),
    );
  }
  await withTxn(async (session) => {
    await StockTxn.deleteMany({ item: item._id }, { session });
    await item.deleteOne({ session });
    await audit(req, 'DELETE', 'Item', item._id, `Deleted ${item.code} ${item.name}`, session);
  });
  res.json({ ok: true });
});

export default router;
