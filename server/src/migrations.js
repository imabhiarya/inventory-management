import Item from './models/Item.js';
import { Receipt, Issue } from './models/Voucher.js';
import { Settings } from './models/misc.js';
import logger from './logger.js';

/**
 * Vouchers created before "Type of Store / Ledger" was tied to the ledger list stored a free-text
 * `store` (e.g. "MES General Store"). Give each one the ledger of its items instead.
 * Safe to run repeatedly; only touches vouchers without a `ledger`.
 */
export async function migrateVoucherLedgers() {
  let fixed = 0;
  for (const Model of [Receipt, Issue]) {
    const docs = await Model.collection.find({ ledger: { $exists: false } }, { projection: { lines: 1 } }).toArray();
    for (const doc of docs) {
      const itemIds = (doc.lines || []).map((l) => l.item);
      const items = await Item.find({ _id: { $in: itemIds } }, { ledger: 1 }).lean();
      // Use the most common ledger among the voucher's items.
      const counts = {};
      for (const it of items) counts[it.ledger] = (counts[it.ledger] || 0) + 1;
      const ledger = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'STATIONARY';
      await Model.collection.updateOne({ _id: doc._id }, { $set: { ledger }, $unset: { store: '' } });
      fixed += 1;
    }
  }
  await Settings.collection.updateOne({ _id: 'app', stores: { $exists: true } }, { $unset: { stores: '' } });
  if (fixed) logger.info(`Migrated ${fixed} voucher(s) to Type of Store / Ledger`);
  return fixed;
}
