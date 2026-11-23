import { z } from 'zod';
import { Counter } from '../models/misc.js';
import { zDay, zText } from '../middleware/validate.js';
import StockTxn from '../models/StockTxn.js';
import { LoanTxn } from '../models/Loan.js';
import { badRequest, conflict, notFound, escapeRegex } from '../utils/httpError.js';

export const pad6 = (n) => String(n).padStart(6, '0');

export async function peekNextNo(key, prefix) {
  const c = await Counter.findById(key).lean();
  return `${prefix}${pad6((c?.seq || 0) + 1)}`;
}

export const listQuery = z.object({
  from: zDay.optional(),
  to: zDay.optional(),
  ledger: z.string().trim().regex(/^[A-Z0-9_]{1,40}$/).optional().or(z.literal('').transform(() => undefined)),
  type: zText(120).optional(),
  status: z.enum(['POSTED', 'CANCELLED', '']).optional(),
  q: zText(100).optional(),
  // 'entered': newest entered first (Recent lists), so back-dated vouchers still show up; default is by voucher date.
  sort: z.enum(['date', 'entered']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(5000).default(50),
});

/** Build a Mongo filter from common register query params. */
export function registerFilter({ from, to, ledger, status, q }, { typeField, typeValue, noField, textFields = [] }) {
  const filter = {};
  if (from || to) filter.date = { ...(from && { $gte: from }), ...(to && { $lte: to }) };
  if (ledger) filter.ledger = ledger;
  if (status) filter.status = status;
  if (typeValue) filter[typeField] = typeValue;
  if (q) {
    const rx = new RegExp(escapeRegex(q), 'i');
    filter.$or = [noField, ...textFields].map((f) => ({ [f]: rx }));
  }
  return filter;
}

export async function paginate(Model, filter, { page, limit, sort }, populate = 'lines.item') {
  const [rows, total] = await Promise.all([
    Model.find(filter)
      .sort(sort === 'entered' ? { createdAt: -1 } : { date: -1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate(populate, 'code name uom ledger')
      .populate('createdBy', 'name username')
      .lean(),
    Model.countDocuments(filter),
  ]);
  return { rows, total, page, limit };
}

export const cancelBody = z.object({ reason: z.string().trim().min(3, 'Please give a reason for cancelling').max(300) });

/**
 * Permanently delete a CANCELLED voucher (admin action). Cancelling already undid its stock / ledger effect;
 * this only refuses if anything it posted is somehow still on record.
 */
export async function deleteCancelled(Model, id, { label, noField }) {
  const doc = await Model.findById(id);
  if (!doc) throw notFound(`${label} not found`);
  if (doc.status !== 'CANCELLED') throw badRequest(`Only a cancelled ${label.toLowerCase()} can be deleted. Cancel ${doc[noField]} first.`);
  const left = (await StockTxn.countDocuments({ voucherId: doc._id })) + (await LoanTxn.countDocuments({ voucherId: doc._id }));
  if (left) throw conflict(`${doc[noField]} still has ledger entries and cannot be deleted`);
  await doc.deleteOne();
  return doc;
}
