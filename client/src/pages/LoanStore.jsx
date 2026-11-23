import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Box, ArrowRight, ArrowLeft, ArrowLeftRight, PackagePlus, Plus, Trash2, Save, Printer, RotateCcw, ClipboardList, Search, Eye, XCircle, X, BookOpen, Building2 } from 'lucide-react';
import { api } from '../api.js';
import { useApp } from '../context/AppContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { useFetch, useItems } from '../hooks.js';
import { PageHeader, Panel, Field, Select, StatusBadge, Modal, CancelDialog, DeleteVoucherDialog, LedgerPrintHeader, OrientationSelect, usePrintOrientation } from '../components/ui.jsx';
import { fmtDate, fmtQty, fyStart, loanKindLabel, numberToWords } from '../utils/format.js';
import { printSection } from '../utils/export.js';

// Loan Store: items received from another unit (Store Entry), issued to sections on a
// temporary basis (Issue) and returned by them (Receipt). It keeps its own Loan Store Ledger and
// does not change the normal ledger stock, so items from any ledger can be used.

const TITLES = { ISSUE: 'LOAN ISSUE VOUCHER', RECEIPT: 'LOAN RECEIPT (RETURN) VOUCHER', BORROW: 'LOAN RECEIPT VOUCHER', DEPOSIT: 'LOAN DEPOSIT VOUCHER' };

/** Simple printable loan voucher. */
function LoanDoc({ v }) {
  const { settings } = useApp();
  const meta = [
    ['Voucher No', v.voucherNo],
    ['Date', fmtDate(v.date)],
    ...(v.kind === 'BORROW'
      ? [['Received From', v.issueTo], ['Type of Store', v.storeType]]
      : v.kind === 'DEPOSIT'
      ? [['Deposited To (Office)', v.issueTo]]
      : [[v.kind === 'ISSUE' ? 'Issue To (Section)' : 'Returned By (Section)', v.issueTo], ['Qtr No', v.qtrNo]]),
    ...(v.kind === 'RECEIPT' ? [['Against Loan Issue', v.reference || v.againstIssue?.voucherNo]] : [['Reference / Authority', v.reference]]),
    ...(v.kind === 'ISSUE' ? [['Return Due Date', fmtDate(v.returnDueDate)]] : []),
    // Loan From Other Sources: each voucher names its partner.
    ...(v.linkedVoucher?.kind === 'ISSUE' ? [['Issued To (Section)', `${v.linkedVoucher.issueTo} (${v.linkedVoucher.voucherNo})`]] : []),
    ...(v.linkedVoucher?.kind === 'BORROW' ? [['Received From (Other Office)', `${v.linkedVoucher.issueTo} (${v.linkedVoucher.voucherNo})`]] : []),
  ].filter(([, val]) => val);
  const sign = {
    BORROW: ['Handed Over By (Other Unit)', 'Received By (Store Keeper)', 'Officer In-Charge'],
    ISSUE: ['Issued By (Store Keeper)', 'Received By (Section)', 'Officer In-Charge'],
    RECEIPT: ['Returned By (Section)', 'Received By (Store Keeper)', 'Officer In-Charge'],
    DEPOSIT: ['Deposited By (Store Keeper)', 'Received By (Other Office)', 'Officer In-Charge'],
  }[v.kind];
  return (
    <div>
      <div className="voucher-head">
        <div className="voucher-form-no">In lieu of IAFZ-2096</div>
        <h4 className="voucher-title">{TITLES[v.kind]}</h4>
        {v.status === 'CANCELLED' && <div className="voucher-cancelled">CANCELLED – {v.cancelReason || ''}</div>}
        <div className="voucher-unit">UNIT:- {settings.orgTitle}</div>
      </div>
      <div className="doc-meta plain">
        {meta.map(([k, val]) => (
          <div key={k}>
            {k}: {val}
          </div>
        ))}
      </div>
      <table className="data">
        <thead>
          <tr>
            <th>Sl.</th>
            <th>Item Name</th>
            <th>A/U</th>
            <th className="num">{{ ISSUE: 'Qty Issued', BORROW: 'Qty Received', RECEIPT: 'Qty Returned', DEPOSIT: 'Qty Deposited' }[v.kind]}</th>
            <th>Remarks</th>
          </tr>
        </thead>
        <tbody>
          {v.lines.map((l, i) => (
            <tr key={i}>
              <td className="center">{i + 1}</td>
              <td>{l.item?.name}</td>
              <td className="center">{l.item?.uom}</td>
              <td className="num">{fmtQty(l.qty)}</td>
              <td>{l.remarks}</td>
            </tr>
          ))}
          <tr className="voucher-count">
            <td colSpan={5}>
              Total Items: {v.lines.length} ({numberToWords(v.lines.length)} Only)
            </td>
          </tr>
        </tbody>
      </table>
      {v.remarks && (
        <p>
          <b>Remarks:</b> {v.remarks}
        </p>
      )}
      <div className="doc-sign">
        {sign.map((s) => (
          <div key={s}>{s}</div>
        ))}
      </div>
    </div>
  );
}

function LoanViewModal({ id, autoPrint, onClose }) {
  const { data, error } = useFetch(`/loans/${id}`);
  const v = data?.voucher;
  useEffect(() => {
    if (v && autoPrint) setTimeout(() => printSection('loan-print'), 150);
  }, [v, autoPrint]);
  return (
    <Modal
          printable
      title={v ? `Loan Voucher ${v.voucherNo}` : 'Loan Voucher'}
      onClose={onClose}
      footer={
        <button type="button" className="btn btn-blue" disabled={!v} onClick={() => printSection('loan-print')}>
          <Printer size={18} /> Print
        </button>
      }
    >
      {error && <p className="error-text">{error}</p>}
      {v && (
        <div id="loan-print">
          <LoanDoc v={v} />
        </div>
      )}
    </Modal>
  );
}

/** A dropdown whose options (a Settings list) can be added to or removed from right here. */
function QuickListPicker({ field, path, noun, value, onChange }) {
  const { settings, canWrite, reloadMeta } = useApp();
  const toast = useToast();
  const options = settings[field] || [];
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (fn, done) => {
    setBusy(true);
    try {
      await fn();
      await reloadMeta();
      done();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  const add = () => {
    const n = name.trim();
    if (n.length < 2) return toast.error(`Enter the ${noun} name`);
    run(
      () => api.post(`/settings/${path}`, { name: n }),
      () => {
        toast.success(`${n} added`);
        onChange(n);
        setName('');
        setAdding(false);
      },
    );
  };
  const remove = () =>
    run(
      () => api.del(`/settings/${path}/${encodeURIComponent(value)}`),
      () => {
        toast.success(`${value} removed from the list`);
        onChange('');
      },
    );

  return (
    <>
      <div className="row" style={{ flexWrap: 'nowrap', gap: 6 }}>
        <select className="input highlight" value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">{options.length ? `Select ${noun}` : 'None yet – add one with +'}</option>
          {options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
        <button type="button" className="btn btn-green" title={`Add ${noun}`} disabled={!canWrite || busy} onClick={() => setAdding((a) => !a)}>
          <Plus size={16} />
        </button>
        <button type="button" className="btn btn-red" title={`Remove selected ${noun} from the list`} disabled={!canWrite || busy || !value} onClick={remove}>
          <Trash2 size={16} />
        </button>
      </div>
      {adding && (
        <div className="row" style={{ flexWrap: 'nowrap', gap: 6, marginTop: 6 }}>
          <input
            className="input"
            autoFocus
            value={name}
            maxLength={120}
            placeholder={`New ${noun} name`}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
          />
          <button type="button" className="btn btn-green" disabled={busy} onClick={add}>
            <Save size={16} /> Add
          </button>
          <button type="button" className="btn btn-outline" onClick={() => setAdding(false)}>
            <X size={16} />
          </button>
        </div>
      )}
    </>
  );
}

/** Item dropdown with every active item, grouped by its ledger. */
function ItemSelect({ items, value, used, onChange, balance }) {
  const { meta } = useApp();
  const groups = useMemo(() => {
    const m = new Map(meta.ledgers.map((l) => [l.key, { label: l.label, items: [] }]));
    for (const it of items) {
      if (!m.has(it.ledger)) m.set(it.ledger, { label: it.ledger, items: [] });
      m.get(it.ledger).items.push(it);
    }
    return [...m.values()].filter((g) => g.items.length);
  }, [items, meta.ledgers]);
  return (
    <select className="inline-input" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Select Item</option>
      {groups.map((g) => (
        <optgroup key={g.label} label={g.label}>
          {g.items.map((x) => (
            <option key={x._id} value={x._id} disabled={used.has(x._id) && x._id !== value}>
              {x.name} ({x.code}){balance ? ` – in loan store: ${fmtQty(balance(x._id))}` : ''}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

const blankRow = () => ({ item: '', qty: '', remarks: '' });

function VoucherHeaderPills({ no, date, onDate }) {
  const { meta } = useApp();
  return (
    <>
      <span className="pill" style={{ fontSize: 13, padding: '4px 10px' }}>Voucher No. : {no}</span>
      <span className="pill" style={{ fontSize: 13, padding: '4px 10px' }}>
        Voucher Date : <input type="date" value={date} max={meta.today} onChange={onDate} style={{ border: 'none', background: 'transparent', fontWeight: 700 }} />
      </span>
    </>
  );
}

function FormActions({ busy, lastSaved, onSave, onPrint, onReset, canSave = true }) {
  const { canWrite } = useApp();
  return (
    <div className="actions">
      <button type="button" className="btn btn-green btn-lg" disabled={!canWrite || busy || !canSave} onClick={onSave}>
        <Save size={20} /> Save Voucher
      </button>
      <button type="button" className="btn btn-blue btn-lg" disabled={!lastSaved} onClick={onPrint}>
        <Printer size={20} /> Print Voucher
      </button>
      <button type="button" className="btn btn-outline btn-lg" onClick={onReset}>
        <RotateCcw size={20} /> Clear / Reset
      </button>
    </div>
  );
}

const QTY_LABEL = { BORROW: 'Qty Received *', ISSUE: 'Qty Issued *', RECEIPT: 'Qty Returned *', OTHER: 'Qty *', DEPOSIT: 'Qty Deposited *' };

/**
 * Item table shared by Store Entry, Issue and Receipt: Item Name (any ledger), A/U, Qty, Remarks.
 * For a receipt, `outFor(itemId)` is how many the chosen section still has out on loan.
 */
function useLoanLines({ kind, outFor, outLabel = 'Out with Section', limit = true }) {
  const { canWrite } = useApp();
  const toast = useToast();
  const { data: itemsData } = useItems();
  const items = useMemo(() => itemsData?.items || [], [itemsData]);
  const byId = useMemo(() => new Map(items.map((i) => [i._id, i])), [items]);
  const [rows, setRows] = useState([blankRow()]);
  const setRow = (i, k, v) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const used = new Set(rows.map((r) => r.item));

  const check = () => {
    const fail = (msg) => {
      toast.error(msg);
      return null;
    };
    const lines = rows.filter((r) => r.item);
    if (!lines.length) return fail('Add at least one item');
    for (const r of lines) {
      const it = byId.get(r.item);
      if (!(Number(r.qty) > 0)) return fail(`Enter quantity for ${it?.name}`);
      if (outFor && limit && Number(r.qty) > outFor(r.item)) return fail(`Only ${fmtQty(outFor(r.item))} ${it.uom} of ${it.name} is out with this section`);
    }
    return lines.map((r) => ({ ...r, qty: Number(r.qty) }));
  };

  const table = (
    <>
      <div className="panel-head" style={{ marginTop: 14, borderRadius: 6 }}>
        <PackagePlus size={18} /> Item Details
        <div className="right">
          <button type="button" className="btn btn-green" onClick={() => setRows([...rows, blankRow()])} disabled={!canWrite}>
            <Plus size={18} /> Add Item
          </button>
        </div>
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Sl.</th>
              <th>Item Name *</th>
              <th>A/U</th>
              {outFor && <th>{outLabel}</th>}
              <th>{QTY_LABEL[kind]}</th>
              <th>Remarks</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const it = byId.get(r.item);
              return (
                <tr key={i}>
                  <td className="center">{i + 1}</td>
                  <td>
                    <ItemSelect items={items} value={r.item} used={used} onChange={(v) => setRow(i, 'item', v)} />
                  </td>
                  <td className="center" style={{ width: 80 }}>{it?.uom}</td>
                  {outFor && <td className="num" style={{ width: 120 }}>{it ? fmtQty(outFor(it._id)) : ''}</td>}
                  <td style={{ width: 110 }}>
                    <input className="inline-input" type="number" min="0" step="any" value={r.qty} onChange={(e) => setRow(i, 'qty', e.target.value)} />
                  </td>
                  <td>
                    <input className="inline-input" value={r.remarks} maxLength={200} onChange={(e) => setRow(i, 'remarks', e.target.value)} />
                  </td>
                  <td className="center">
                    <button type="button" className="icon-btn del" title="Remove" onClick={() => setRows(rows.length > 1 ? rows.filter((_, j) => j !== i) : [blankRow()])}>
                      <Trash2 size={18} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!items.length && <p className="muted">No active items. Register them in New Stock Entry first.</p>}
    </>
  );
  return { table, check, reset: () => setRows([blankRow()]) };
}

/** Store Entry: items received on loan from another unit. */
function StoreEntryForm({ onSaved }) {
  const { meta } = useApp();
  const toast = useToast();
  const { data: nextNo, reload: reloadNo } = useFetch('/loans/next-no', { kind: 'BORROW' });
  const fresh = () => ({ date: meta.today, issueTo: '', storeType: '', reference: '', remarks: '' });
  const [h, setH] = useState(fresh);
  const [busy, setBusy] = useState(false);
  const [lastSaved, setLastSaved] = useState(null);
  const lines = useLoanLines({ kind: 'BORROW' });
  const set = (k) => (v) => setH((s) => ({ ...s, [k]: v?.target ? v.target.value : v }));
  const reset = () => {
    setH(fresh());
    lines.reset();
  };

  const save = async () => {
    if (!h.issueTo) return toast.error('Select the unit the items are received from');
    const body = lines.check();
    if (!body) return;
    setBusy(true);
    try {
      const { voucher } = await api.post('/loans/entry', { ...h, lines: body });
      toast.success(`Store entry ${voucher.voucherNo} saved`);
      setLastSaved(voucher._id);
      reset();
      reloadNo();
      onSaved(voucher._id);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Store Entry (Items Received from Other Unit)" icon={ArrowLeftRight} right={<VoucherHeaderPills no={nextNo?.next} date={h.date} onDate={set('date')} />}>
      <div className="grid-3">
        <Field label="Received From (Other Unit)" required stack>
          <QuickListPicker field="otherOffices" path="other-offices" noun="unit" value={h.issueTo} onChange={set('issueTo')} />
        </Field>
        <Field label="Type of Store" stack>
          <QuickListPicker field="storeTypes" path="store-types" noun="type of store" value={h.storeType} onChange={set('storeType')} />
        </Field>
        <Field label="Reference / Authority No." stack>
          <input className="input" value={h.reference} onChange={set('reference')} maxLength={80} />
        </Field>
        <Field label="Remarks" stack>
          <input className="input" value={h.remarks} onChange={set('remarks')} maxLength={300} />
        </Field>
      </div>
      {lines.table}
      <FormActions busy={busy} lastSaved={lastSaved} onSave={save} onPrint={() => onSaved(lastSaved, true)} onReset={reset} />
    </Panel>
  );
}

/** Section box (with the Units / Sections list as suggestions), shared by Issue and Receipt. */
function SectionInput({ id, value, onChange }) {
  const { settings } = useApp();
  return (
    <>
      <input className="input highlight" list={id} value={value} onChange={onChange} maxLength={160} placeholder="Select or type the section" />
      <datalist id={id}>
        {settings.units.map((u) => (
          <option key={u} value={u} />
        ))}
      </datalist>
    </>
  );
}

/**
 * Simple Issue / Receipt form: section, Qtr No, remarks and the items (any ledger).
 * Issue sends items to a section on loan; Receipt takes them back from that section.
 */
function SimpleLoanForm({ kind, onSaved }) {
  const { meta } = useApp();
  const toast = useToast();
  const isIssue = kind === 'ISSUE';
  const { data: nextNo, reload: reloadNo } = useFetch('/loans/next-no', { kind });
  const { data: out, reload: reloadOut } = useFetch(isIssue ? null : '/loans/outstanding');
  const fresh = () => ({ date: meta.today, issueTo: '', qtrNo: '', remarks: '' });
  const [h, setH] = useState(fresh);
  const [busy, setBusy] = useState(false);
  const [lastSaved, setLastSaved] = useState(null);
  const set = (k) => (v) => setH((s) => ({ ...s, [k]: v?.target ? v.target.value : v }));

  // What the chosen section still has out on loan, per item.
  const outBy = useMemo(() => {
    const m = new Map();
    const sec = h.issueTo.trim().toLowerCase();
    for (const r of out?.rows || []) {
      if (r.issueTo.trim().toLowerCase() !== sec) continue;
      for (const l of r.lines) m.set(l.item._id, (m.get(l.item._id) || 0) + l.outstanding);
    }
    return m;
  }, [out, h.issueTo]);
  const lines = useLoanLines({ kind, outFor: isIssue ? null : (id) => outBy.get(id) || 0 });
  const reset = () => {
    setH(fresh());
    lines.reset();
  };

  const save = async () => {
    if (!h.issueTo.trim()) return toast.error(isIssue ? 'Enter the section the items are issued to' : 'Enter the section returning the items');
    const body = lines.check();
    if (!body) return;
    setBusy(true);
    try {
      const { voucher } = await api.post(isIssue ? '/loans/issue' : '/loans/receipt', { ...h, lines: body });
      toast.success(`${isIssue ? 'Loan issue' : 'Loan receipt'} ${voucher.voucherNo} saved`);
      setLastSaved(voucher._id);
      reset();
      reloadNo();
      if (!isIssue) reloadOut();
      onSaved(voucher._id);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title={isIssue ? 'Loan Issue (To Section)' : 'Loan Receipt (Returned by Section)'}
      icon={ArrowLeftRight}
      right={<VoucherHeaderPills no={nextNo?.next} date={h.date} onDate={set('date')} />}
    >
      <div className="grid-3">
        <Field label={isIssue ? 'Issued Section' : 'Returned by Section'} required stack>
          <SectionInput id={`loan-sections-${kind}`} value={h.issueTo} onChange={set('issueTo')} />
        </Field>
        <Field label="Qtr No" stack>
          <input className="input" value={h.qtrNo} onChange={set('qtrNo')} maxLength={40} />
        </Field>
        <Field label="Remarks" stack>
          <input className="input" value={h.remarks} onChange={set('remarks')} maxLength={300} placeholder={isIssue ? '' : 'e.g. Returned (Good Condition)'} />
        </Field>
      </div>
      {lines.table}
      <FormActions busy={busy} lastSaved={lastSaved} onSave={save} onPrint={() => onSaved(lastSaved, true)} onReset={reset} />
    </Panel>
  );
}

/**
 * Loan From Other Sources: items received from another office and issued straight to a section.
 * Saves a Loan Receipt Voucher (for the office) and a Loan Issue Voucher (for the section).
 */
function ReceiveIssueForm({ onSaved, modeSwitch }) {
  const { meta, canWrite } = useApp();
  const toast = useToast();
  const { data: recNo, reload: reloadRec } = useFetch('/loans/next-no', { kind: 'BORROW' });
  const { data: issNo, reload: reloadIss } = useFetch('/loans/next-no', { kind: 'ISSUE' });
  const fresh = () => ({ date: meta.today, issueTo: '', section: '', reference: '', remarks: '' });
  const [h, setH] = useState(fresh);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(null); // { receipt, issue }
  const lines = useLoanLines({ kind: 'OTHER' });
  const set = (k) => (v) => setH((s) => ({ ...s, [k]: v?.target ? v.target.value : v }));
  const reset = () => {
    setH(fresh());
    lines.reset();
  };

  const save = async () => {
    if (!h.issueTo) return toast.error('Select the office the items are received from');
    if (!h.section.trim()) return toast.error('Enter the section the items are issued to');
    const body = lines.check();
    if (!body) return;
    setBusy(true);
    try {
      const { receipt, issue } = await api.post('/loans/other-source', { ...h, lines: body });
      toast.success(`Saved Loan Receipt ${receipt.voucherNo} and Loan Issue ${issue.voucherNo}`);
      setSaved({ receipt: receipt._id, issue: issue._id });
      reset();
      reloadRec();
      reloadIss();
      onSaved(receipt._id);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  const pill = { fontSize: 13, padding: '4px 10px' };
  return (
    <Panel
      title="Loan From Other Sources (Received from Office → Issued to Section)"
      icon={ArrowLeftRight}
      right={
        <>
          <span className="pill" style={pill}>Loan Receipt No. : {recNo?.next}</span>
          <span className="pill" style={pill}>Issue No. : {issNo?.next}</span>
          <span className="pill" style={pill}>
            Date : <input type="date" value={h.date} max={meta.today} onChange={set('date')} style={{ border: 'none', background: 'transparent', fontWeight: 700 }} />
          </span>
        </>
      }
    >
      {modeSwitch}
      <div className="grid-3">
        <Field label="Received From (Other Office)" required stack>
          <QuickListPicker field="otherOffices" path="other-offices" noun="office" value={h.issueTo} onChange={set('issueTo')} />
        </Field>
        <Field label="Issue To (Section)" required stack>
          <SectionInput id="other-sections" value={h.section} onChange={set('section')} />
        </Field>
        <Field label="Reference / Authority No." stack>
          <input className="input" value={h.reference} onChange={set('reference')} maxLength={80} />
        </Field>
        <Field label="Remarks" stack>
          <input className="input" value={h.remarks} onChange={set('remarks')} maxLength={300} />
        </Field>
      </div>
      {lines.table}
      <div className="actions">
        <button type="button" className="btn btn-green btn-lg" disabled={!canWrite || busy} onClick={save}>
          <Save size={20} /> Save
        </button>
        <button type="button" className="btn btn-blue btn-lg" disabled={!saved} onClick={() => onSaved(saved.receipt, true)}>
          <Printer size={20} /> Print Loan Receipt Voucher
        </button>
        <button type="button" className="btn btn-blue btn-lg" disabled={!saved} onClick={() => onSaved(saved.issue, true)}>
          <Printer size={20} /> Print Issue Voucher
        </button>
        <button type="button" className="btn btn-outline btn-lg" onClick={reset}>
          <RotateCcw size={20} /> Clear / Reset
        </button>
      </div>
    </Panel>
  );
}

/** Loan Deposit: items given back to the office they were taken on loan from. */
function DepositForm({ onSaved, modeSwitch }) {
  const { meta } = useApp();
  const toast = useToast();
  const { data: nextNo, reload: reloadNo } = useFetch('/loans/next-no', { kind: 'DEPOSIT' });
  const { data: taken, reload: reloadTaken } = useFetch('/loans/outstanding', { kind: 'BORROW' });
  const fresh = () => ({ date: meta.today, issueTo: '', reference: '', remarks: '' });
  const [h, setH] = useState(fresh);
  const [busy, setBusy] = useState(false);
  const [lastSaved, setLastSaved] = useState(null);
  const set = (k) => (v) => setH((s) => ({ ...s, [k]: v?.target ? v.target.value : v }));

  // What is still held on loan from the chosen office, per item (shown as a guide, not a limit).
  const takenBy = useMemo(() => {
    const m = new Map();
    const office = h.issueTo.trim().toLowerCase();
    for (const r of taken?.rows || []) {
      if (r.issueTo.trim().toLowerCase() !== office) continue;
      for (const l of r.lines) m.set(l.item._id, (m.get(l.item._id) || 0) + l.outstanding);
    }
    return m;
  }, [taken, h.issueTo]);
  const lines = useLoanLines({ kind: 'DEPOSIT', outFor: (id) => takenBy.get(id) || 0, outLabel: 'Taken from Office', limit: false });
  const reset = () => {
    setH(fresh());
    lines.reset();
  };

  const save = async () => {
    if (!h.issueTo) return toast.error('Select the office the items are deposited to');
    const body = lines.check();
    if (!body) return;
    setBusy(true);
    try {
      const { voucher } = await api.post('/loans/deposit', { ...h, lines: body });
      toast.success(`Loan deposit ${voucher.voucherNo} saved`);
      setLastSaved(voucher._id);
      reset();
      reloadNo();
      reloadTaken();
      onSaved(voucher._id);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Loan Deposit (Returned to Office)" icon={ArrowLeftRight} right={<VoucherHeaderPills no={nextNo?.next} date={h.date} onDate={set('date')} />}>
      {modeSwitch}
      <div className="grid-3">
        <Field label="Deposited To (Other Office)" required stack>
          <QuickListPicker field="otherOffices" path="other-offices" noun="office" value={h.issueTo} onChange={set('issueTo')} />
        </Field>
        <Field label="Reference / Authority No." stack>
          <input className="input" value={h.reference} onChange={set('reference')} maxLength={80} />
        </Field>
        <Field label="Remarks" stack>
          <input className="input" value={h.remarks} onChange={set('remarks')} maxLength={300} />
        </Field>
      </div>
      {lines.table}
      <FormActions busy={busy} lastSaved={lastSaved} onSave={save} onPrint={() => onSaved(lastSaved, true)} onReset={reset} />
    </Panel>
  );
}

/** Loan From Other Sources tab: receive from an office and issue to a section, or deposit back to the office. */
function OtherSourceForm({ onSaved }) {
  const [mode, setMode] = useState('receive');
  const modeSwitch = (
    <div className="tabs" style={{ marginBottom: 12 }}>
      <button type="button" className={`tab ${mode === 'receive' ? 'active' : ''}`} onClick={() => setMode('receive')}>
        <ArrowLeft size={18} /> Received from Office → Issue to Section
      </button>
      <button type="button" className={`tab ${mode === 'deposit' ? 'active' : ''}`} onClick={() => setMode('deposit')}>
        <ArrowRight size={18} /> Loan Deposit (Return to Office)
      </button>
    </div>
  );
  return mode === 'receive' ? <ReceiveIssueForm onSaved={onSaved} modeSwitch={modeSwitch} /> : <DepositForm onSaved={onSaved} modeSwitch={modeSwitch} />;
}

/** Loan Store Ledger: a summary of every item, or one item's movements with a running balance. */
export function LoanLedger() {
  const [orientation, setOrientation] = usePrintOrientation();
  const { meta, ledgerLabel, settings } = useApp();
  const { data: itemsData } = useItems();
  const items = itemsData?.items || [];
  const loanStoreTypes = settings.loanStoreTypes?.length ? settings.loanStoreTypes : ['Furniture Store', 'T&P Store', 'Other Items'];
  const [f, setF] = useState({ from: fyStart(meta.currentFy), to: meta.today, item: '', storeType: '' });
  const [applied, setApplied] = useState(f);
  const { data, loading } = useFetch('/loans/ledger', applied);
  const item = data?.item;

  return (
    <Panel
      title="Loan Store Ledger"
      icon={BookOpen}
      right={
        <div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
          <OrientationSelect value={orientation} onChange={setOrientation} />
          <button type="button" className="btn btn-blue" disabled={!data} onClick={() => printSection('loan-ledger-print', { orientation })}>
            <Printer size={18} /> Print
          </button>
        </div>
      }
    >
      <form
        className="filters no-print"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(f);
        }}
      >
        <Field label="From Date" stack>
          <input className="input" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
        </Field>
        <Field label="To Date" stack>
          <input className="input" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
        </Field>
        <Field label="Type of Loan Store" stack>
          <Select value={f.storeType} onChange={(v) => setF({ ...f, storeType: v })} placeholder="All Types" options={loanStoreTypes} />
        </Field>
        <Field label="Item" stack>
          <Select value={f.item} onChange={(v) => setF({ ...f, item: v })} placeholder="All items (summary)" options={items.map((i) => ({ value: i._id, label: `${i.name} (${i.code})` }))} />
        </Field>
        <button className="btn btn-blue">
          <Search size={18} /> View Ledger
        </button>
      </form>
      <div id="loan-ledger-print" style={{ marginTop: 12 }}>
        <div className="voucher-head print-doc">
          <LedgerPrintHeader ledger={ledgerLabel('LOAN')} asOn={fmtDate(applied.to)} />
          {applied.storeType && <div>Type of Loan Store: {applied.storeType}</div>}
          {item && <div>Item: {item.name} ({item.code}) · A/U: {item.uom}</div>}
        </div>
        <div className="table-wrap">
          {item ? (
            <table className="data">
              <thead>
                <tr>
                  <th>Sl.</th>
                  <th>Date</th>
                  <th>Voucher No.</th>
                  <th>Particulars</th>
                  <th>Type of Loan Store</th>
                  <th className="num">Received</th>
                  <th className="num">Issued</th>
                  <th className="num">Balance</th>
                  <th>Remarks</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r, i) =>
                  r.opening ? (
                    <tr key="op">
                      <td />
                      <td className="center">{fmtDate(applied.from)}</td>
                      <td />
                      <td>
                        <b>Opening Balance</b>
                      </td>
                      <td />
                      <td />
                      <td />
                      <td className="num">
                        <b>{fmtQty(r.balance)}</b>
                      </td>
                      <td />
                    </tr>
                  ) : (
                    <tr key={r._id}>
                      <td className="center">{i}</td>
                      <td className="center">{fmtDate(r.date)}</td>
                      <td className="center">{r.voucherNo}</td>
                      <td>
                        {r.typeLabel}
                        {r.party ? ` – ${r.party}` : ''}
                      </td>
                      <td>{r.storeType || '-'}</td>
                      <td className="num">{r.inQty ? fmtQty(r.inQty) : ''}</td>
                      <td className="num">{r.outQty ? fmtQty(r.outQty) : ''}</td>
                      <td className="num">{fmtQty(r.balance)}</td>
                      <td>{r.remarks}</td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>Sl.</th>
                  <th>Item Name</th>
                  <th>Type of Loan Store</th>
                  <th>A/U</th>
                  <th className="num">Opening</th>
                  <th className="num">Received</th>
                  <th className="num">Issued</th>
                  <th className="num">Returned by Sections</th>
                  <th className="num">Deposited to Office</th>
                  <th className="num">Balance in Loan Store</th>
                  <th className="num">Out with Sections</th>
                </tr>
              </thead>
              <tbody>
                {(data?.rows || []).map((r, i) => (
                  <tr key={r.item._id}>
                    <td className="center">{i + 1}</td>
                    <td>
                      {r.item.name} ({r.item.code})
                    </td>
                    <td>{r.storeTypes?.length ? r.storeTypes.join(', ') : '-'}</td>
                    <td className="center">{r.item.uom}</td>
                    <td className="num">{fmtQty(r.opening)}</td>
                    <td className="num">{fmtQty(r.received)}</td>
                    <td className="num">{fmtQty(r.issued)}</td>
                    <td className="num">{fmtQty(r.returned)}</td>
                    <td className="num">{fmtQty(r.deposited)}</td>
                    <td className="num">
                      <b>{fmtQty(r.closing)}</b>
                    </td>
                    <td className="num">{fmtQty(r.withSections)}</td>
                  </tr>
                ))}
                {!data?.rows?.length && (
                  <tr>
                    <td colSpan={11} className="empty">
                      {loading ? 'Loading…' : 'Nothing in the Loan Store Ledger for this period.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </Panel>
  );
}

/** Status shown in the register for each kind of loan voucher. */
function registerStatus(v) {
  if (v.status === 'CANCELLED') return 'CANCELLED';
  if (v.kind === 'ISSUE') return v.returnStatus;
  if (v.kind === 'BORROW') return { PARTIAL: 'PART_DEPOSITED', RETURNED: 'DEPOSITED' }[v.returnStatus] || 'RECEIVED';
  if (v.kind === 'DEPOSIT') return 'DEPOSITED';
  return 'RECEIVED';
}

const TABS = [
  { key: 'entry', label: 'Store Entry', icon: PackagePlus },
  { key: 'issue', label: 'Issue', icon: ArrowRight },
  { key: 'receipt', label: 'Receipt', icon: ArrowLeft },
  { key: 'other', label: 'Loan From Other Sources', icon: Building2 },
  { key: 'ledger', label: 'Loan Store Ledger', icon: BookOpen },
];

export default function LoanStore() {
  const { meta, settings, canWrite, isAdmin } = useApp();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const asked = params.get('tab');
  const tab = TABS.some((t) => t.key === asked) ? asked : 'entry';
  const [f, setF] = useState({ from: fyStart(meta.currentFy), to: meta.today, kind: '', issueTo: '' });
  const [applied, setApplied] = useState(f);
  const { data, loading, reload } = useFetch('/loans', { ...applied, limit: 200 });
  const [view, setView] = useState(null);
  const [cancel, setCancel] = useState(null);
  const [removing, setRemoving] = useState(null);

  const onSaved = (id, print) => {
    reload();
    if (print) setView({ id, print: true });
  };

  return (
    <>
      <PageHeader icon={Box} plainIcon title="Loan Store" />
      <div className="tabs">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button key={key} type="button" className={`tab ${tab === key ? 'active' : ''}`} onClick={() => setParams(key === 'entry' ? {} : { tab: key })}>
            <Icon size={20} /> {label}
          </button>
        ))}
      </div>
      {tab === 'entry' && <StoreEntryForm onSaved={onSaved} />}
      {tab === 'issue' && <SimpleLoanForm key="issue" kind="ISSUE" onSaved={onSaved} />}
      {tab === 'receipt' && <SimpleLoanForm key="receipt" kind="RECEIPT" onSaved={onSaved} />}
      {tab === 'other' && <OtherSourceForm onSaved={onSaved} />}
      {tab === 'ledger' && <LoanLedger />}

      {tab !== 'ledger' && (
        <Panel title="Loan Store Register" icon={ClipboardList} light bodyClass="panel-body">
          <form
            className="filters"
            onSubmit={(e) => {
              e.preventDefault();
              setApplied(f);
            }}
          >
            <Field label="From Date" stack>
              <input className="input" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
            </Field>
            <Field label="To Date" stack>
              <input className="input" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
            </Field>
            <Field label="Transaction Type" stack>
              <Select
                value={f.kind}
                onChange={(v) => setF({ ...f, kind: v })}
                placeholder="All"
                options={[
                  { value: 'BORROW', label: 'Store Entry / Loan Receipt' },
                  { value: 'DEPOSIT', label: 'Loan Deposit' },
                  { value: 'ISSUE', label: 'Loan Issue' },
                  { value: 'RECEIPT', label: 'Loan Receipt' },
                ]}
              />
            </Field>
            <Field label="Section / Unit" stack>
              <Select value={f.issueTo} onChange={(v) => setF({ ...f, issueTo: v })} placeholder="All" options={[...new Set([...settings.units, ...(settings.otherOffices || [])])]} />
            </Field>
            <button className="btn btn-blue">
              <Search size={18} /> View Register
            </button>
          </form>
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table className="data">
              <thead>
                <tr>
                  <th>Sl.</th>
                  <th>Voucher No.</th>
                  <th>Date</th>
                  <th>Transaction Type</th>
                  <th>Section / Unit</th>
                  <th>Qtr No</th>
                  <th>No. of Items</th>
                  <th>Due Date</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {(data?.rows || []).map((v, i) => (
                  <tr key={v._id}>
                    <td className="center">{i + 1}</td>
                    <td className="center">{v.voucherNo}</td>
                    <td className="center">{fmtDate(v.date)}</td>
                    <td className="center">
                      <span className={`badge ${{ ISSUE: 'badge-blue', BORROW: 'badge-purple', DEPOSIT: 'badge-teal' }[v.kind] || 'badge-green'}`}>{v.kind === 'BORROW' && v.linkedVoucher ? 'Loan From Other Source' : loanKindLabel(v.kind)}</span>
                    </td>
                    <td>{v.issueTo}</td>
                    <td className="center">{v.qtrNo}</td>
                    <td className="center">{v.lines.length}</td>
                    <td className="center">{v.kind === 'ISSUE' ? fmtDate(v.returnDueDate) : ''}</td>
                    <td className="center">
                      <StatusBadge status={registerStatus(v)} />
                    </td>
                    <td className="center" style={{ whiteSpace: 'nowrap' }}>
                      <button type="button" className="icon-btn edit" title="View" onClick={() => setView({ id: v._id })}>
                        <Eye size={18} />
                      </button>
                      <button type="button" className="icon-btn" title="Print" onClick={() => setView({ id: v._id, print: true })}>
                        <Printer size={18} />
                      </button>
                      {canWrite && v.status === 'POSTED' && (
                        <button type="button" className="icon-btn del" title="Cancel" onClick={() => setCancel(v)}>
                          <XCircle size={18} />
                        </button>
                      )}
                      {isAdmin && v.status === 'CANCELLED' && (
                        <button type="button" className="icon-btn del" title="Delete permanently" onClick={() => setRemoving(v)}>
                          <Trash2 size={18} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {!data?.rows?.length && (
                  <tr>
                    <td colSpan={10} className="empty">
                      {loading ? 'Loading…' : 'No loan vouchers in this period.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {view && <LoanViewModal key={`${view.id}-${view.print}`} id={view.id} autoPrint={view.print} onClose={() => setView(null)} />}
      {cancel && (
        <CancelDialog
          title={`Cancel ${cancel.voucherNo}?`}
          onClose={() => setCancel(null)}
          onConfirm={async (reason) => {
            await api.post(`/loans/${cancel._id}/cancel`, { reason });
            toast.success(`${cancel.voucherNo} cancelled`);
            reload();
          }}
        />
      )}
      {removing && (
        <DeleteVoucherDialog
          voucherNo={removing.voucherNo}
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            const { deleted } = await api.del(`/loans/${removing._id}`);
            toast.success(`${(deleted || [removing.voucherNo]).join(' & ')} deleted`);
            reload();
          }}
        />
      )}
    </>
  );
}
