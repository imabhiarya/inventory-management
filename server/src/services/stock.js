import mongoose from 'mongoose';
import Item from '../models/Item.js';
import StockTxn from '../models/StockTxn.js';
import { badRequest, round3 } from '../utils/httpError.js';

/** Run `fn(session)` in a MongoDB transaction (retries on transient conflicts). */
export async function withTxn(fn) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

export async function loadItem(itemId, session) {
  const item = await Item.findById(itemId).session(session);
  if (!item) throw badRequest('One of the selected items no longer exists');
  return item;
}

// Stock changes are made on the in-memory Item documents of a voucher (see loadItemsForLines) and
// saved together by saveItems() once the whole voucher has been posted. Editing a voucher first
// takes out what it posted and then posts the new version, so a balance may dip below zero part
// way through; only the final balance (and the ledger history) has to stay at or above zero.

/** Add stock and update the weighted average rate. */
export function stockIn(item, qty, rate) {
  const cur = item.currentStock;
  const next = round3(cur + qty);
  const effectiveRate = rate > 0 ? rate : item.avgRate;
  let avg = item.avgRate;
  if (next > 0) {
    avg = cur > 0 ? (cur * item.avgRate + qty * effectiveRate) / next : effectiveRate;
    if (!Number.isFinite(avg) || avg < 0) avg = effectiveRate;
  }
  item.currentStock = next;
  item.avgRate = Math.round(avg * 100) / 100;
}

/** Remove stock; refuses to go negative. */
export function stockOut(item, qty, context = 'issue') {
  const next = round3(item.currentStock - qty);
  if (next < 0) {
    throw badRequest(
      `Insufficient stock for ${item.name} (${item.code}): available ${Math.max(0, item.currentStock)} ${item.uom}, cannot ${context} ${qty}`,
    );
  }
  item.currentStock = next;
}

/** Undo a receipt line: remove the stock and back the receipt out of the average rate. */
export function reverseStockIn(item, qty, rate) {
  const cur = item.currentStock;
  const next = round3(cur - qty);
  if (next > 0 && rate > 0) {
    const avg = (cur * item.avgRate - qty * rate) / next;
    if (avg >= 0 && Number.isFinite(avg)) item.avgRate = Math.round(avg * 100) / 100;
  }
  item.currentStock = next;
}

/** Undo an issue line: put the stock back (average rate unchanged). */
export function reverseStockOut(item, qty) {
  item.currentStock = round3(item.currentStock + qty);
}

/** Save the voucher's items, refusing if any balance would end up below zero. */
export async function saveItems(items, session) {
  for (const item of items.values()) {
    if (item.currentStock < 0) {
      throw badRequest(
        `Not enough stock of ${item.name} (${item.code}): this change would leave ${item.currentStock} ${item.uom}. ` +
          'Some of it has already been issued; cancel or reduce those issues first.',
      );
    }
  }
  for (const item of items.values()) if (item.isModified()) await item.save({ session });
}

/**
 * The ledger is kept by date, so a back-dated or re-dated voucher must not make an item's balance
 * drop below zero on any day, even if today's balance is fine (e.g. an issue dated before the
 * receipt that brought the stock in). Checked inside the transaction, after the voucher is written.
 */
export async function assertHistoryNotNegative(itemIds, session) {
  const ids = [...new Set(itemIds.map(String))].map((id) => new mongoose.Types.ObjectId(id));
  if (!ids.length) return;
  const days = await StockTxn.aggregate([
    { $match: { item: { $in: ids } } },
    { $group: { _id: { item: '$item', date: '$date' }, net: { $sum: { $subtract: ['$receiptQty', '$issueQty'] } } } },
    { $sort: { '_id.item': 1, '_id.date': 1 } },
  ]).session(session);
  const running = new Map();
  for (const d of days) {
    const key = d._id.item.toString();
    const bal = round3((running.get(key) || 0) + d.net);
    running.set(key, bal);
    if (bal < 0) {
      const item = await Item.findById(d._id.item, 'code name uom').session(session).lean();
      const day = d._id.date.toISOString().slice(0, 10).split('-').reverse().join('-');
      throw badRequest(
        `${item?.name} (${item?.code}) would go below zero on ${day} (balance ${bal} ${item?.uom}). ` +
          'An issue cannot be dated before the receipt that brought the stock in; check the voucher dates.',
      );
    }
  }
}

/** Remember a voucher line's ledger page on the Item Master when it has none yet, so later vouchers auto-fill it. */
export function rememberLedgerPage(item, ledgerPageNo) {
  const page = (ledgerPageNo || '').trim();
  if (page && !item.ledgerPage) item.ledgerPage = page;
}

export async function writeTxns(rows, session) {
  if (rows.length) await StockTxn.insertMany(rows, { session, ordered: true });
}

export async function deleteTxns(voucherId, session) {
  await StockTxn.deleteMany({ voucherId }, { session });
}

/** Ensure every referenced item exists, is active and (optionally) belongs to `ledger` ({ key, label }). */
export async function loadItemsForLines(lines, session, { ledger, allowInactive = false, items = new Map() } = {}) {
  const seen = new Set();
  for (const line of lines) {
    const id = line.item.toString();
    if (!seen.has(id)) {
      seen.add(id);
      const item = items.get(id) || (await loadItem(id, session));
      if (!allowInactive && item.status !== 'ACTIVE') throw badRequest(`${item.name} (${item.code}) is inactive`);
      if (ledger && item.ledger !== ledger.key) throw badRequest(`${item.name} (${item.code}) is not in the ${ledger.label}`);
      items.set(id, item);
    }
  }
  return items;
}
