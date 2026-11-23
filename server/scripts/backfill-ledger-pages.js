// Fill in the Item Master's Ledger Page for items that have none, from the most recent
// posted receipt or issue line that recorded one. Items that already have a page are left alone.
// Usage:  npm run backfill:ledger-pages            (dry run: shows what would change)
//         npm run backfill:ledger-pages -- --apply
import env from '../src/config/env.js';
import { connectDb, disconnectDb } from '../src/db.js';
import Item from '../src/models/Item.js';
import { Receipt, Issue } from '../src/models/Voucher.js';

async function latestPages() {
  const pages = new Map(); // itemId -> { page, at }
  for (const Model of [Receipt, Issue]) {
    const vouchers = await Model.find({ status: 'POSTED' }, { date: 1, createdAt: 1, lines: 1 }).lean();
    for (const v of vouchers) {
      const at = [new Date(v.date).getTime(), new Date(v.createdAt || 0).getTime()];
      for (const l of v.lines) {
        const page = (l.ledgerPageNo || '').trim();
        if (!page) continue;
        const key = l.item.toString();
        const cur = pages.get(key);
        if (!cur || at[0] > cur.at[0] || (at[0] === cur.at[0] && at[1] >= cur.at[1])) pages.set(key, { page, at });
      }
    }
  }
  return pages;
}

async function main() {
  const apply = process.argv.includes('--apply');
  await connectDb(env.MONGODB_URI);
  const pages = await latestPages();
  const blank = await Item.find({ $or: [{ ledgerPage: { $exists: false } }, { ledgerPage: '' }] });
  let changed = 0;
  for (const item of blank) {
    const found = pages.get(item._id.toString());
    if (!found) continue;
    console.log(`${item.code}  ${item.name}  ->  ledger page ${found.page}`);
    if (apply) {
      item.ledgerPage = found.page;
      await item.save();
    }
    changed += 1;
  }
  console.log(`${changed} item(s) ${apply ? 'updated' : 'would be updated (dry run; pass --apply to save)'}.`);
  await disconnectDb();
}

main().then(
  // Exit explicitly: open handles (timers, the IPC channel of an Electron utility
  // process) can otherwise keep the process alive after the work is done.
  () => process.exit(process.exitCode ?? 0),
  async (e) => {
    console.error(e.message);
    await disconnectDb().catch(() => {});
    process.exit(1);
  },
);
