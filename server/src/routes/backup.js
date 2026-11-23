import { Router } from 'express';
import { z } from 'zod';
import User from '../models/User.js';
import Item from '../models/Item.js';
import StockTxn from '../models/StockTxn.js';
import { LoanTxn, LoanStock } from '../models/Loan.js';
import { Receipt, Issue, LoanVoucher } from '../models/Voucher.js';
import { Counter, Settings, AuditLog, audit } from '../models/misc.js';
import { AuditObservation } from '../models/AuditObservation.js';
import { PurchaseOrder } from '../models/PurchaseOrder.js';
import { Demand } from '../models/Demand.js';
import { ConsolidatedDemand } from '../models/ConsolidatedDemand.js';
import { adminOnly } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { withTxn } from '../services/stock.js';
import { badRequest } from '../utils/httpError.js';
import { migrateVoucherLedgers } from '../migrations.js';

const router = Router();
router.use(adminOnly);

const FORMAT = 'mes-store-backup';
const VERSION = 1;

// Order matters for restore readability only; there are no FK constraints in MongoDB.
const COLLECTIONS = {
  settings: Settings,
  counters: Counter,
  users: User,
  items: Item,
  receipts: Receipt,
  issues: Issue,
  loanVouchers: LoanVoucher,
  stockTxns: StockTxn,
  loanTxns: LoanTxn,
  loanStocks: LoanStock,
  auditLogs: AuditLog,
  auditObservations: AuditObservation, // the attached files (GridFS) are not in the JSON backup
  purchaseOrders: PurchaseOrder,
  demands: Demand,
  consolidatedDemands: ConsolidatedDemand,
};

router.get('/', async (req, res) => {
  const data = {};
  for (const [key, Model] of Object.entries(COLLECTIONS)) data[key] = await Model.find().lean();
  await audit(req, 'BACKUP', 'Database', null, 'Downloaded full backup');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  res.setHeader('Content-Disposition', `attachment; filename="mes-store-backup-${stamp}.json"`);
  res.json({ format: FORMAT, version: VERSION, createdAt: new Date(), createdBy: req.user.username, data });
});

const restoreSchema = z.object({
  format: z.literal(FORMAT, { message: 'This file is not an MES Store backup' }),
  version: z.literal(VERSION, { message: 'Unsupported backup version' }),
  data: z.object(Object.fromEntries(Object.keys(COLLECTIONS).map((k) => [k, z.array(z.record(z.string(), z.unknown())).default([])]))),
});

router.post('/restore', validate(restoreSchema), async (req, res) => {
  const { data } = req.valid.body;
  const restoreUsers = data.users.some((u) => u.role === 'admin' && u.active !== false && u.passwordHash);
  if (data.users.length && !restoreUsers) throw badRequest('Backup has no active admin user; refusing to restore users');

  // Backups taken before vouchers had a Type of Store / Ledger: derive it from the voucher's items.
  const itemLedger = new Map(data.items.map((i) => [String(i._id), i.ledger]));
  for (const v of [...data.receipts, ...data.issues]) {
    if (!v.ledger) {
      v.ledger = itemLedger.get(String(v.lines?.[0]?.item)) || 'STATIONARY';
      delete v.store;
    }
  }
  if (data.settings[0]) delete data.settings[0].stores;

  const counts = await withTxn(async (session) => {
    const out = {};
    for (const [key, Model] of Object.entries(COLLECTIONS)) {
      if (key === 'users' && !restoreUsers) continue;
      await Model.deleteMany({}, { session });
      if (data[key].length) await Model.insertMany(data[key], { session, ordered: true });
      out[key] = data[key].length;
    }
    await audit(req, 'RESTORE', 'Database', null, `Restored backup (${JSON.stringify(out)})`, session);
    return out;
  });
  await migrateVoucherLedgers(); // older backups may predate voucher ledgers
  res.json({ ok: true, counts, usersRestored: restoreUsers });
});

export default router;
