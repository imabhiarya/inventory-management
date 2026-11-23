import { z } from 'zod';
import mongoose from 'mongoose';
import { badRequest } from '../utils/httpError.js';
import { parseDay, today } from '../utils/dates.js';

/** Validate req.body / req.query / req.params; parsed values land in req.valid[part]. */
export const validate =
  (schema, part = 'body') =>
  (req, res, next) => {
    const result = schema.safeParse(req[part] ?? {});
    if (!result.success) {
      const details = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
      const first = details[0];
      throw badRequest(first.path ? `${first.path}: ${first.message}` : first.message, details);
    }
    req.valid = { ...(req.valid || {}), [part]: result.data };
    next();
  };

// ---- Reusable field schemas ----
export const zText = (max = 200) => z.string().trim().max(max);
export const zReqText = (label, max = 200) => z.string().trim().min(1, `${label} is required`).max(max);
export const zId = z.string().refine((v) => mongoose.isValidObjectId(v), 'Invalid id');
export const zDay = z
  .string()
  .transform((v, ctx) => {
    const d = parseDay(v);
    if (!d) {
      ctx.addIssue({ code: 'custom', message: 'Invalid date (expected YYYY-MM-DD)' });
      return z.NEVER;
    }
    return d;
  });
/** A voucher date: valid day, not in the future (IST). */
export const zVoucherDay = zDay.refine((d) => d <= today(), 'Date cannot be in the future');
export const zLedgerKey = z.string().trim().regex(/^[A-Z0-9_]{1,40}$/, 'Invalid ledger');
export const zOptLedgerKey = zLedgerKey.optional().or(z.literal('').transform(() => undefined));
export const zQty = z.coerce.number().positive('Quantity must be greater than 0').max(1e9);
export const zMoney = z.coerce.number().min(0).max(1e12);
export const idParam = z.object({ id: zId });
