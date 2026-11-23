import { useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import { Eye, Printer, Pencil, XCircle, Search, Trash2 } from 'lucide-react';
import { api } from '../api.js';
import { useApp } from '../context/AppContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { useFetch } from '../hooks.js';
import { Modal, Field, Select, StatusBadge, CancelDialog, DeleteVoucherDialog } from './ui.jsx';
import { fmtDate, fmtMoney, fmtQty, oldNoLabel, fmtMonth, numberToWords } from '../utils/format.js';
import { printSection } from '../utils/export.js';

/**
 * Config per voucher kind. `meta` rows render on the printed voucher; `lineCols` are the item table.
 */
export const KINDS = {
  receipt: {
    endpoint: '/receipts',
    one: 'receipt',
    title: 'Receipt Voucher',
    noField: 'receiptNo',
    typeField: 'receiptType',
    party: (v) => v.source,
    meta: (v, ledgerLabel) => [
      ['Receipt No.', v.receiptNo],
      // B/F receipts carry the Old Ledger Page instead of an Old RV No.
      isBF(v) ? ['Old Ledger Page', v.oldLedgerPage || '—'] : ['Old RV No.', v.oldRvNo || '—'],
      ['Receipt Date', fmtDate(v.date)],
      ['Receipt Type', v.receiptType],
      ['Source / From', v.source],
      ['Type of Store / Ledger', ledgerLabel(v.ledger)],
      ['PO / Sanction No.', v.poNo],
      ['PO / Sanction Date', v.poDate ? fmtDate(v.poDate) : '—'],
    ],
    lineCols: [
      ['Code Head', (l) => l.codeHead],
      ['Item Name', (l) => `${l.item?.name || ''} (${l.item?.code || ''})`],
      ['UoM', (l) => l.item?.uom],
      ['Qty', (l) => fmtQty(l.qty), 'num'],
      ['Rate (₹)', (l) => fmtMoney(l.rate), 'num'],
      ['Amount (₹)', (l) => fmtMoney(l.amount), 'num'],
      ['Ledger Pg', (l) => l.ledgerPageNo],
    ],
    signatures: ['Received By', 'Store Keeper', 'Officer In-Charge'],
  },
  issue: {
    endpoint: '/issues',
    one: 'issue',
    title: 'Issue Voucher',
    noField: 'issueNo',
    typeField: 'issueType',
    party: (v) => v.issueTo,
    meta: (v, ledgerLabel) => [
      ['Issue No.', v.issueNo],
      ['Old IV No.', v.oldIvNo || '—'],
      ['Issue Date', fmtDate(v.date)],
      ['Issue Type', v.issueType],
      ['Issue Frequency', v.frequency === 'MONTHLY' ? `Monthly (CIV)${v.civMonth ? ` – ${fmtMonth(v.civMonth)}` : ''}` : 'Regular'],
      ['Issue To / Unit / Section', v.issueTo],
      ['Type of Store / Ledger', ledgerLabel(v.ledger)],
      ['Issue Authority / Ref.', v.authorityRef],
    ],
    lineCols: [
      ['Item Name', (l) => `${l.item?.name || ''} (${l.item?.code || ''})`],
      ['UoM', (l) => l.item?.uom],
      ['Qty Issued', (l) => fmtQty(l.qty), 'num'],
      // No Rate, Amount or Total Amount on the printed issue voucher.
      ['Ledger Pg', (l) => l.ledgerPageNo],
      ['Remarks', (l) => l.remarks],
    ],
    signatures: ['Issued By (Store Keeper)', 'Received By', 'Officer In-Charge'],
  },
};

// Loan Store Ledger vouchers have no PO / sanction, code head, rate or amount, and are numbered
// as Loan Receipt / Loan Issue.
const LOAN_HIDE_COLS = ['Code Head', 'Rate (₹)', 'Amount (₹)'];
const LOAN_HIDE_META = ['PO / Sanction No.', 'PO / Sanction Date'];
const LOAN_RENAME = { 'Receipt No.': 'Loan Receipt No.', 'Issue No.': 'Loan Issue No.' };
const isLoanVoucher = (v) => v.ledger === 'LOAN';
// B/F (brought forward) receipts have no PO / sanction.
const isBF = (v) => (v.receiptType || '').replace(/[^a-z]/gi, '').toUpperCase() === 'BF';
export const voucherCols = (cfg, v) => (isLoanVoucher(v) ? cfg.lineCols.filter(([h]) => !LOAN_HIDE_COLS.includes(h)) : cfg.lineCols);
const voucherMeta = (cfg, v, ledgerLabel) => {
  const rows = cfg.meta(v, ledgerLabel);
  let kept = isLoanVoucher(v) || isBF(v) ? rows.filter(([k]) => !LOAN_HIDE_META.includes(k)) : rows;
  // Loan Store Ledger vouchers show their Type of Loan Store right after the ledger.
  if (v.loanStoreType) {
    const at = kept.findIndex(([k]) => k === 'Type of Store / Ledger');
    kept = [...kept.slice(0, at + 1), ['Type of Loan Store', v.loanStoreType], ...kept.slice(at + 1)];
  }
  // Stock Indents (Maint Store sub-ledgers) are numbered as Stock Indent No.
  if (v.issueType === 'Stock Indent') return kept.map(([k, val]) => [k === 'Issue No.' ? 'Stock Indent No.' : k, val]);
  return isLoanVoucher(v) ? kept.map(([k, val]) => [LOAN_RENAME[k] || k, val]) : kept;
};

/**
 * Print a voucher straight after saving it. Browsers may ignore window.print() when it comes long
 * after the click, so the voucher is fetched, rendered synchronously and printed at once, with no
 * modal or timer in between. Render `node` somewhere on the page (it is hidden on screen).
 */
export function useVoucherPrinter(kind) {
  const cfg = KINDS[kind];
  const [voucher, setVoucher] = useState(null);
  const elId = `${kind}-autoprint`;
  const printNow = async (id) => {
    const data = await api.get(`${cfg.endpoint}/${id}`);
    flushSync(() => setVoucher(data[cfg.one]));
    printSection(elId); // clones the rendered voucher into the print area and opens the print dialog
    setVoucher(null);
  };
  const node = voucher ? (
    <div className="print-doc" id={elId}>
      <VoucherDoc kind={kind} voucher={voucher} />
    </div>
  ) : null;
  return { printNow, node };
}

/** Printable voucher (receipt or issue). */
export function VoucherDoc({ kind, voucher }) {
  const cfg = KINDS[kind];
  const { ledgerLabel, settings } = useApp();
  const cols = voucherCols(cfg, voucher);
  const amountIdx = cols.findIndex(([h]) => h.startsWith('Amount'));
  return (
    <div>
      {/* Form heading: Issue, Receipt and Expense Voucher (in lieu of IAFZ-2096). */}
      <div className="voucher-head">
        <div className="voucher-form-no">In lieu of IAFZ-2096</div>
        <h4 className="voucher-title">
          {isLoanVoucher(voucher) ? (kind === 'issue' ? 'LOAN ISSUE VOUCHER' : 'LOAN RECEIPT VOUCHER') : 'ISSUE, RECEIPT AND EXPENSE VOUCHER'}
        </h4>
        {voucher.status === 'CANCELLED' && <div className="voucher-cancelled">CANCELLED – {voucher.cancelReason || ''}</div>}
        <div className="voucher-unit">UNIT:- {settings.orgTitle}</div>
      </div>
      <div className="doc-meta plain">
        {voucherMeta(cfg, voucher, ledgerLabel).map(([k, v]) => (
          <div key={k}>
            {k}: {v}
          </div>
        ))}
      </div>
      <table className="data">
        <thead>
          <tr>
            <th>Sl.</th>
            {cols.map(([h, , cls]) => (
              <th key={h} className={cls}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {voucher.lines.map((l, i) => (
            <tr key={i}>
              <td className="center">{i + 1}</td>
              {cols.map(([h, fn, cls]) => (
                <td key={h} className={cls}>
                  {fn(l)}
                </td>
              ))}
            </tr>
          ))}
          {/* Item count in words after the last item. */}
          <tr className="voucher-count">
            <td colSpan={cols.length + 1}>
              Total Items: {voucher.lines.length} ({numberToWords(voucher.lines.length)} Only)
            </td>
          </tr>
        </tbody>
        {amountIdx >= 0 && (
          <tfoot>
            <tr>
              <td colSpan={amountIdx + 1} className="num">
                Total Amount (₹)
              </td>
              <td className="num">{fmtMoney(voucher.totalAmount)}</td>
              <td colSpan={cols.length - amountIdx - 1} />
            </tr>
          </tfoot>
        )}
      </table>
      {voucher.remarks && (
        <p>
          <b>Remarks:</b> {voucher.remarks}
        </p>
      )}
      <div className="doc-sign">
        {cfg.signatures.map((s) => (
          <div key={s}>{s}</div>
        ))}
      </div>
    </div>
  );
}

/** Loads a voucher by id and shows it with a Print button; optionally prints straight away. */
export function VoucherViewModal({ kind, id, autoPrint, onClose }) {
  const cfg = KINDS[kind];
  const { data, error } = useFetch(`${cfg.endpoint}/${id}`);
  const voucher = data?.[cfg.one];
  useEffect(() => {
    if (voucher && autoPrint) setTimeout(() => printSection('voucher-print'), 150);
  }, [voucher, autoPrint]);
  return (
    <Modal
      title={voucher ? `${cfg.title} ${voucher[cfg.noField]}` : cfg.title}
      onClose={onClose}
      footer={
        <button type="button" className="btn btn-blue" disabled={!voucher} onClick={() => printSection('voucher-print')}>
          <Printer size={18} /> Print
        </button>
      }
    >
      {error && <div className="error-text">{error.message}</div>}
      {!voucher && !error && <div className="muted">Loading…</div>}
      {voucher && (
        <div id="voucher-print">
          <VoucherDoc kind={kind} voucher={voucher} />
          {voucher.createdBy && (
            <p className="muted no-print" style={{ fontSize: 12 }}>
              Entered by {voucher.createdBy.name}
              {voucher.cancelledBy && ` · Cancelled by ${voucher.cancelledBy.name} on ${fmtDate(voucher.cancelledAt)}`}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}

/** Register table rows shared by the "Recent" list and the register modal. */
export function VoucherRows({ kind, rows, onView, onPrint, onEdit, onCancel, onDelete, colSpan }) {
  const cfg = KINDS[kind];
  const { ledgerLabel } = useApp();
  if (!rows.length) {
    return (
      <tr>
        <td colSpan={colSpan} className="empty">
          No vouchers found.
        </td>
      </tr>
    );
  }
  return rows.map((v) => (
    <tr key={v._id}>
      <td className="center">
        {v[cfg.noField]}
        {oldNoLabel(v) && <div className="muted" style={{ fontSize: 12 }}>{oldNoLabel(v)}</div>}
      </td>
      <td className="center">{fmtDate(v.date)}</td>
      <td>
        {ledgerLabel(v.ledger)}
        {v.loanStoreType && <div className="item-desc">{v.loanStoreType}</div>}
      </td>
      <td>{cfg.party(v)}</td>
      <td className="center">{v[cfg.typeField]}</td>
      {kind === 'receipt' && <td className="center">{[...new Set(v.lines.map((l) => l.codeHead).filter(Boolean))].join(', ')}</td>}
      <td className="center">{v.lines.length}</td>
      <td className="num">{fmtMoney(v.totalAmount)}</td>
      <td className="center">
        <StatusBadge status={v.status} />
      </td>
      <td className="center" style={{ whiteSpace: 'nowrap' }}>
        <button type="button" className="icon-btn edit" title="View" onClick={() => onView(v)}>
          <Eye size={18} />
        </button>
        <button type="button" className="icon-btn" title="Print" onClick={() => onPrint(v)}>
          <Printer size={18} />
        </button>
        {onEdit && v.status === 'POSTED' && (
          <button type="button" className="icon-btn edit" title="Edit" onClick={() => onEdit(v)}>
            <Pencil size={18} />
          </button>
        )}
        {onCancel && v.status === 'POSTED' && (
          <button type="button" className="icon-btn del" title="Cancel" onClick={() => onCancel(v)}>
            <XCircle size={18} />
          </button>
        )}
        {onDelete && v.status === 'CANCELLED' && (
          <button type="button" className="icon-btn del" title="Delete permanently" onClick={() => onDelete(v)}>
            <Trash2 size={18} />
          </button>
        )}
      </td>
    </tr>
  ));
}

export function RegisterHead({ kind }) {
  return (
    <thead>
      <tr>
        <th>{kind === 'receipt' ? 'Receipt No.' : 'Issue No.'}</th>
        <th>{kind === 'receipt' ? 'Receipt Date' : 'Issue Date'}</th>
        <th>Type of Store / Ledger</th>
        <th>{kind === 'receipt' ? 'Source / From' : 'Issue To / Unit / Section'}</th>
        <th>{kind === 'receipt' ? 'Receipt Type' : 'Issue Type'}</th>
        {kind === 'receipt' && <th>Code Head</th>}
        <th>No. of Items</th>
        <th className="num">Amount (₹)</th>
        <th>Status</th>
        <th>Action</th>
      </tr>
    </thead>
  );
}

/** Searchable register in a modal. mode: 'view' | 'edit' | 'cancel'. */
export function RegisterModal({ kind, mode, onClose, onEdit, onChanged }) {
  const cfg = KINDS[kind];
  const { meta, settings, canWrite, isAdmin } = useApp();
  const toast = useToast();
  // No From date by default, so back-dated vouchers (e.g. B/F from old years) are listed too.
  const [f, setF] = useState({ from: '', to: meta.today, type: '', ledger: '', q: '', status: mode === 'view' ? '' : 'POSTED' });
  const [applied, setApplied] = useState(f);
  const { data, loading, reload } = useFetch(cfg.endpoint, { ...applied, limit: 200 });
  const [view, setView] = useState(null);
  const [cancel, setCancel] = useState(null);
  const [removing, setRemoving] = useState(null);
  const types = kind === 'receipt' ? settings.receiptTypes : settings.issueTypes;
  const titles = { view: 'Register', edit: 'Select a voucher to edit', cancel: 'Select a voucher to cancel' };

  return (
    <Modal title={`${kind === 'receipt' ? 'Receipt' : 'Issue'} ${titles[mode]}`} onClose={onClose} size="">
      <form
        className="filters"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(f);
        }}
      >
        <Field label="From" stack>
          <input className="input" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
        </Field>
        <Field label="To" stack>
          <input className="input" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
        </Field>
        <Field label="Type of Store / Ledger" stack>
          <Select value={f.ledger} onChange={(v) => setF({ ...f, ledger: v })} placeholder="All Ledgers" options={meta.ledgers.map((l) => ({ value: l.key, label: l.label }))} />
        </Field>
        <Field label="Type" stack>
          <Select value={f.type} onChange={(v) => setF({ ...f, type: v })} placeholder="All" options={types} />
        </Field>
        <div className="field stack grow">
          <label>Search</label>
          <input className="input" value={f.q} placeholder="Voucher no., party, ref…" onChange={(e) => setF({ ...f, q: e.target.value })} />
        </div>
        <button className="btn btn-blue">
          <Search size={18} /> Search
        </button>
      </form>
      <div className="table-wrap" style={{ marginTop: 12, maxHeight: '55vh', overflowY: 'auto' }}>
        <table className="data">
          <RegisterHead kind={kind} />
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={10} className="empty">
                  Loading…
                </td>
              </tr>
            ) : (
              <VoucherRows
                kind={kind}
                colSpan={10}
                rows={data?.rows || []}
                onView={(v) => setView({ id: v._id })}
                onPrint={(v) => setView({ id: v._id, print: true })}
                onEdit={canWrite && mode !== 'cancel' ? (v) => onEdit(v._id) : null}
                onCancel={canWrite && mode !== 'edit' ? (v) => setCancel(v) : null}
                onDelete={isAdmin && mode !== 'edit' ? (v) => setRemoving(v) : null}
              />
            )}
          </tbody>
        </table>
      </div>
      {data && data.total > data.rows.length && (
        <p className="muted">
          Showing the latest {data.rows.length} of {data.total}. Narrow the dates to see older vouchers.
        </p>
      )}
      {view && <VoucherViewModal kind={kind} id={view.id} autoPrint={view.print} onClose={() => setView(null)} />}
      {cancel && (
        <CancelDialog
          title={`Cancel ${cancel[cfg.noField]}?`}
          onClose={() => setCancel(null)}
          onConfirm={async (reason) => {
            await api.post(`${cfg.endpoint}/${cancel._id}/cancel`, { reason });
            toast.success(`${cancel[cfg.noField]} cancelled`);
            reload();
            onChanged?.();
          }}
        />
      )}
      {removing && (
        <DeleteVoucherDialog
          voucherNo={removing[cfg.noField]}
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            await api.del(`${cfg.endpoint}/${removing._id}`);
            toast.success(`${removing[cfg.noField]} deleted`);
            reload();
            onChanged?.();
          }}
        />
      )}
    </Modal>
  );
}
