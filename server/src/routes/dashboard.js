import { Router } from 'express';
import Item from '../models/Item.js';
import { Receipt, Issue, LoanVoucher } from '../models/Voucher.js';
import { today, monthRange } from '../utils/dates.js';
import { lowStockItems } from '../services/stockView.js';

const router = Router();

router.get('/', async (req, res) => {
  const t = today();
  const month = monthRange(t.toISOString().slice(0, 7));
  const inMonth = { status: 'POSTED', date: { $gte: month.from, $lte: month.to } };
  const [items, activeItems, lowStock, receiptsMonth, issuesMonth, loansOut, loansOverdue, recentReceipts, recentIssues] =
    await Promise.all([
      Item.countDocuments(),
      Item.countDocuments({ status: 'ACTIVE' }),
      lowStockItems(),
      Receipt.countDocuments(inMonth),
      Issue.countDocuments(inMonth),
      LoanVoucher.countDocuments({ kind: 'ISSUE', status: 'POSTED', returnStatus: { $in: ['ISSUED', 'PARTIAL'] } }),
      LoanVoucher.countDocuments({
        kind: 'ISSUE',
        status: 'POSTED',
        returnStatus: { $in: ['ISSUED', 'PARTIAL'] },
        returnDueDate: { $lt: t },
      }),
      Receipt.find({ status: 'POSTED' }).sort({ date: -1, createdAt: -1 }).limit(5).select('receiptNo date source totalAmount').lean(),
      Issue.find({ status: 'POSTED' }).sort({ date: -1, createdAt: -1 }).limit(5).select('issueNo date issueTo totalAmount').lean(),
    ]);
  res.json({
    counts: { items, activeItems, lowStock: lowStock.length, receiptsMonth, issuesMonth, loansOut, loansOverdue },
    lowStock: [...lowStock]
      .sort((a, b) => a.currentStock - b.currentStock)
      .slice(0, 8)
      .map(({ _id, code, name, uom, currentStock, minStock, ledger }) => ({ _id, code, name, uom, currentStock, minStock, ledger })),
    recentReceipts,
    recentIssues,
  });
});

export default router;
