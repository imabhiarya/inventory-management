// Full-database backup and restore, shared by the API route (Backup & Restore page) and by
// scripts/restore-backup.js (the desktop app's first-run "restore from a backup file" option,
// used to move everything to a new PC when the old one has failed).
import mongoose from 'mongoose';
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
import { Dcs } from '../models/Dcs.js';
import { withTxn } from './stock.js';
import { badRequest } from '../utils/httpError.js';
import { migrateVoucherLedgers } from '../migrations.js';

export const BACKUP_FORMAT = 'mes-store-backup';
// v2 adds `files`: the audit attachments (GridFS bucket "auditFiles"), base64-encoded.
// v1 files (no attachments) still restore.
export const BACKUP_VERSION = 2;
const FILES_BUCKET = 'auditFiles';

// Order matters for restore readability only; there are no FK constraints in MongoDB.
export const COLLECTIONS = {
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
  auditObservations: AuditObservation,
  purchaseOrders: PurchaseOrder,
  demands: Demand,
  consolidatedDemands: ConsolidatedDemand,
  dcs: Dcs, // its quotation files are in `files` with the audit attachments
};

const bucket = () => new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: FILES_BUCKET });

async function readFile(id) {
  const chunks = [];
  for await (const chunk of bucket().openDownloadStream(id)) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** The whole database as one plain object, ready to be sent or written as JSON. */
export async function buildBackup(createdBy) {
  const data = {};
  for (const [key, Model] of Object.entries(COLLECTIONS)) data[key] = await Model.find().lean();
  const files = [];
  for (const f of await bucket().find().toArray()) {
    files.push({ _id: f._id, filename: f.filename, metadata: f.metadata, uploadDate: f.uploadDate, data: (await readFile(f._id)).toString('base64') });
  }
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, createdAt: new Date(), createdBy, data, files };
}

export const backupSchema = z.object({
  format: z.literal(BACKUP_FORMAT, { message: 'This file is not an MES Store backup' }),
  version: z.union([z.literal(1), z.literal(2)], { message: 'This backup was made by a newer version of the software. Update the software first.' }),
  createdAt: z.unknown().optional(),
  createdBy: z.unknown().optional(),
  data: z.object(Object.fromEntries(Object.keys(COLLECTIONS).map((k) => [k, z.array(z.record(z.string(), z.unknown())).default([])]))),
  files: z
    .array(z.object({ _id: z.string().regex(/^[0-9a-f]{24}$/), filename: z.string(), metadata: z.unknown().optional(), uploadDate: z.unknown().optional(), data: z.string() }))
    .optional(),
});

export const hasActiveAdmin = (users) => users.some((u) => u.role === 'admin' && u.active !== false && u.passwordHash);

/**
 * Replaces all data with the backup's. `req` is only used for the audit-log entry
 * (the signed-in user, or a stand-in when run from the desktop first-run setup).
 */
export async function restoreBackup(backup, req, { requireUsers = false } = {}) {
  const { data, files } = backup;
  const restoreUsers = hasActiveAdmin(data.users);
  if (data.users.length && !restoreUsers) throw badRequest('Backup has no active admin user; refusing to restore users');
  if (requireUsers && !restoreUsers) throw badRequest('This backup has no administrator account, so nobody could sign in after restoring it.');

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

  // Attachments (GridFS cannot take part in the transaction, so they follow it). Backups made
  // before attachments were included (v1) leave the files already here untouched.
  if (files) {
    const db = mongoose.connection.db;
    await db.collection(`${FILES_BUCKET}.files`).deleteMany({});
    await db.collection(`${FILES_BUCKET}.chunks`).deleteMany({});
    for (const f of files) {
      await new Promise((resolve, reject) => {
        const up = bucket().openUploadStreamWithId(new mongoose.Types.ObjectId(f._id), f.filename, { metadata: f.metadata });
        up.once('error', reject);
        up.once('finish', resolve);
        up.end(Buffer.from(f.data, 'base64'));
      });
    }
    counts.files = files.length;
  }

  await migrateVoucherLedgers(); // older backups may predate voucher ledgers
  return { counts, usersRestored: restoreUsers };
}
