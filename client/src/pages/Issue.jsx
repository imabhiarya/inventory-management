import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Upload, ClipboardList, Package, Plus, Pencil, Trash2, Save, Printer, RotateCcw, Settings2, Layers, FileText, XCircle,
  ChevronRight, CalendarDays, ArrowLeftRight,
} from 'lucide-react';
import { api } from '../api.js';
import { useApp } from '../context/AppContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { useFetch, useItems } from '../hooks.js';
import { PageHeader, Panel, Field, Select } from '../components/ui.jsx';
import LedgerPicker from '../components/LedgerPicker.jsx';
import { RegisterHead, RegisterModal, VoucherRows, VoucherViewModal, useVoucherPrinter } from '../components/vouchers.jsx';
import { fmtMoney, fmtQty, isoDay, MONTH_NAMES } from '../utils/format.js';

const blankLine = { item: '', qty: '', ledgerPageNo: '', remarks: '' };
const FREQUENCIES = [
  { value: 'REGULAR', label: 'Regular' },
  { value: 'MONTHLY', label: 'Monthly (Certified Issue Voucher)' },
];

/** Issue type (and number label) used for issues from Maint Store sub-ledgers. */
const STOCK_INDENT = 'Stock Indent';

export default function Issue() {
  const { meta, settings, canWrite, ledgerLabel } = useApp();
  const toast = useToast();
  const navigate = useNavigate();
  const newHeader = () => ({
    date: meta.today,
    issueType: settings.issueTypes[0] || '',
    frequency: 'REGULAR',
    civMonth: '',
    ledger: meta.ledgers[0]?.key || '',
    oldIvNo: '',
    loanStoreType: '',
    issueTo: '',
    authorityRef: '',
    remarks: '',
  });
  const [header, setHeader] = useState(newHeader);
  const [lines, setLines] = useState([]);
  const [line, setLine] = useState(blankLine);
  const [editLine, setEditLine] = useState(-1);
  const [editId, setEditId] = useState(null);
  const [editNo, setEditNo] = useState('');
  const [original, setOriginal] = useState([]); // lines of the voucher being edited (their qty is "available" again)
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState(null);
  const printer = useVoucherPrinter('issue');

  const { data: itemsData, reload: reloadItems } = useItems();
  const items = useMemo(() => itemsData?.items || [], [itemsData]);
  const itemById = useMemo(() => new Map(items.map((i) => [i._id, i])), [items]);
  const { data: nextNo, reload: reloadNo } = useFetch('/issues/next-no', { ledger: header.ledger });
  // The Loan Store Ledger has no rate / amount, and its own Loan Issue No.
  const isLoan = header.ledger === 'LOAN';
  const loanStoreTypes = settings.loanStoreTypes?.length ? settings.loanStoreTypes : ['Furniture Store', 'T&P Store', 'Other Items'];
  // Issues from a sub-ledger (Maint Store → B&R / E&M) are Stock Indents with their own number series.
  const isIndentLedger = (key) => !!(meta.allLedgers || meta.ledgers).find((l) => l.key === key)?.parent;
  const isIndent = isIndentLedger(header.ledger);
  const issueTypeOptions = isIndent ? [STOCK_INDENT] : settings.issueTypes;
  const { data: recent, reload: reloadRecent } = useFetch('/issues', { limit: 5, sort: 'entered' });
  // Loan Store Ledger items are held in the separate Loan Store Ledger, not normal stock.
  const { data: loanData, reload: reloadLoan } = useFetch(isLoan ? '/loans/stock' : null);
  const balanceOf = (it) => (isLoan ? loanData?.stock?.[it._id] || 0 : it.currentStock);

  /** Stock available for `itemId` given what is already on this voucher (excluding line `skip`). */
  const available = (itemId, skip = -1) => {
    const it = itemById.get(itemId);
    if (!it) return 0;
    const back = original.filter((l) => l.item === itemId).reduce((s, l) => s + l.qty, 0);
    const used = lines.filter((l, i) => l.item === itemId && i !== skip).reduce((s, l) => s + Number(l.qty), 0);
    return Math.round((balanceOf(it) + back - used) * 1000) / 1000;
  };

  const selected = itemById.get(line.item);

  // Selecting an item fills in its Ledger Page No. from the Item Master (still editable).
  const pickItem = (id) => setLine((l) => ({ ...l, item: id, ledgerPageNo: itemById.get(id)?.ledgerPage || '' }));
  const total = lines.reduce((s, l) => s + Number(l.qty) * (itemById.get(l.item)?.avgRate || 0), 0);

  const reset = () => {
    setHeader(newHeader());
    setLines([]);
    setLine(blankLine);
    setEditLine(-1);
    setEditId(null);
    setEditNo('');
    setOriginal([]);
  };

  const addLine = () => {
    if (!line.item) return toast.error('Select an item');
    const qty = Number(line.qty);
    if (!(qty > 0)) return toast.error('Enter the quantity issued');
    if (!line.ledgerPageNo.trim()) return toast.error('Enter the ledger page no.');
    const avail = available(line.item, editLine);
    // Loan Store items may be issued beyond the Loan Store balance (as on the Loan Store page).
    if (!isLoan && qty > avail) return toast.error(`Only ${fmtQty(avail)} ${selected?.uom || ''} available`);
    const l = { ...line, qty };
    setLines((ls) => (editLine >= 0 ? ls.map((x, i) => (i === editLine ? l : x)) : [...ls, l]));
    setLine(blankLine);
    setEditLine(-1);
  };

  const save = async (print) => {
    if (!lines.length) return toast.error('Add at least one item');
    setBusy(true);
    try {
      const body = { ...header, lines: lines.map(({ item, qty, ledgerPageNo, remarks }) => ({ item, qty, ledgerPageNo, remarks })) };
      const { issue } = editId ? await api.put(`/issues/${editId}`, body) : await api.post('/issues', body);
      toast.success(`Issue ${issue.issueNo} ${editId ? 'updated' : 'saved'}`);
      reset();
      reloadNo();
      reloadRecent();
      reloadItems();
      reloadLoan();
      if (print) {
        try {
          await printer.printNow(issue._id);
        } catch {
          toast.error('Saved, but the voucher could not be printed. Use Print in the voucher window.');
        }
        setModal({ type: 'view', id: issue._id }); // stays open with a Print button for reprints
      }
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  const loadForEdit = async (id) => {
    setModal(null);
    try {
      const { issue } = await api.get(`/issues/${id}`);
      const ls = issue.lines.map((l) => ({ item: l.item._id, qty: l.qty, ledgerPageNo: l.ledgerPageNo, remarks: l.remarks || '' }));
      setEditId(issue._id);
      setEditNo(issue.issueNo);
      setOriginal(ls);
      setHeader({
        date: isoDay(issue.date),
        issueType: issue.issueType,
        frequency: issue.frequency || 'REGULAR',
        civMonth: issue.civMonth || (issue.frequency === 'MONTHLY' ? isoDay(issue.date).slice(0, 7) : ''),
        ledger: issue.ledger,
        oldIvNo: issue.oldIvNo || '',
        loanStoreType: issue.loanStoreType || '',
        issueTo: issue.issueTo,
        authorityRef: issue.authorityRef,
        remarks: issue.remarks || '',
      });
      setLines(ls);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      toast.error(e.message);
    }
  };

  const h = (k) => (v) => setHeader((s) => ({ ...s, [k]: v?.target ? v.target.value : v }));
  // Only items registered in the selected Type of Store / Ledger can go on this voucher.
  const ledgerItems = useMemo(() => items.filter((it) => it.ledger === header.ledger), [items, header.ledger]);
  // Monthly (CIV) issues: month + year the voucher is certified for, stored as 'YYYY-MM'.
  const monthly = header.frequency === 'MONTHLY';
  const civY = header.civMonth.slice(0, 4) || meta.today.slice(0, 4);
  const civM = header.civMonth.slice(5, 7) || meta.today.slice(5, 7);
  const thisYear = Number(meta.today.slice(0, 4));
  const civYears = Array.from({ length: 6 }, (_, i) => String(thisYear - i)).concat(Number(civY) < thisYear - 5 ? [civY] : []);

  return (
    <>
      <PageHeader icon={Upload} title="Issue (Goods Issue)" />
      <div className="with-aside">
        <div>
          <Panel title={editId ? `Edit Issue ${editNo}` : 'Issue Entry'} icon={ClipboardList}>
            {/* Two independent columns, laid out like the Receipt page. */}
            <div className="grid-2">
              <div className="form-col">
                <Field label="Type of Store / Ledger" required>
                  <LedgerPicker
                    value={header.ledger}
                    onChange={(v) => {
                      // Maint Store sub-ledgers issue on a Stock Indent; switching back restores the normal issue type.
                      setHeader((s) => ({
                        ...s,
                        ledger: v,
                        loanStoreType: v === 'LOAN' ? s.loanStoreType || loanStoreTypes[0] || '' : '',
                        issueType: isIndentLedger(v)
                          ? STOCK_INDENT
                          : s.issueType === STOCK_INDENT
                            ? settings.issueTypes[0] || ''
                            : s.issueType,
                      }));
                      setLine(blankLine);
                      setEditLine(-1);
                    }}
                    disabled={lines.length > 0}
                    title={lines.length ? 'Remove the items below to change the ledger' : undefined}
                  />
                </Field>
                {/* Loan Store Ledger only: which loan store the items belong to (list in Settings). */}
                {isLoan && (
                  <Field label="Type of Loan Store" required>
                    <Select
                      className="input highlight"
                      value={header.loanStoreType}
                      onChange={h('loanStoreType')}
                      placeholder="— Select —"
                      options={loanStoreTypes}
                    />
                  </Field>
                )}
                <Field label="Issue Type" required>
                  <Select value={header.issueType} onChange={h('issueType')} options={issueTypeOptions} />
                </Field>
                <Field label={isLoan ? 'Loan Issue No.' : isIndent ? 'Stock Indent No.' : 'Issue No.'} required>
                  <input className="input" readOnly value={editId ? editNo : nextNo?.next || ''} title="Assigned automatically when saved" />
                </Field>
                {/* Shown beside the Issue No. in registers, ledger and reports. */}
                <Field label="Old IV No.">
                  <input className="input" value={header.oldIvNo} onChange={h('oldIvNo')} placeholder="Enter Old IV No. (manual)" maxLength={40} />
                </Field>
              </div>
              <div className="form-col">
                <Field label="Issue Authority / Ref." required>
                  <input className="input" value={header.authorityRef} onChange={h('authorityRef')} placeholder="IA/2025-26/0145" maxLength={80} />
                </Field>
                <Field label="Issue Frequency" required>
                  <Select
                    value={header.frequency}
                    // Monthly defaults to the issue date's month.
                    onChange={(v) => setHeader((s) => ({ ...s, frequency: v, civMonth: v === 'MONTHLY' ? s.civMonth || s.date.slice(0, 7) : '' }))}
                    options={FREQUENCIES}
                    title="Monthly issues are consolidated on the Certified Issue Voucher (Reports)"
                  />
                </Field>
                {/* Monthly issues: the month this issue is certified for on the CIV. */}
                {monthly && (
                  <Field label="Month / Year" required>
                    <div className="row" style={{ flexWrap: 'nowrap', gap: 8 }}>
                      <Select
                        value={civM}
                        onChange={(m) => setHeader((s) => ({ ...s, civMonth: `${civY}-${m}` }))}
                        options={MONTH_NAMES.map((n, i) => ({ value: String(i + 1).padStart(2, '0'), label: n }))}
                        aria-label="Month"
                      />
                      <Select
                        value={civY}
                        onChange={(y) => setHeader((s) => ({ ...s, civMonth: `${y}-${civM}` }))}
                        options={civYears}
                        aria-label="Year"
                        style={{ maxWidth: 110 }}
                      />
                    </div>
                  </Field>
                )}
                <Field label="Issue Date" required>
                  <input className="input" type="date" value={header.date} max={meta.today} onChange={h('date')} />
                </Field>
                <Field label="Issue To / Unit / Section" required>
                  <input className="input" list="units" value={header.issueTo} onChange={h('issueTo')} placeholder="Select or type" maxLength={160} />
                  <datalist id="units">
                    {settings.units.map((s) => (
                      <option key={s} value={s} />
                    ))}
                  </datalist>
                </Field>
              </div>
            </div>
          </Panel>

          <Panel title="Item Details" icon={Package}>
            {canWrite && (
              <div className="filters" style={{ marginBottom: 12 }}>
                <div className="field stack grow">
                  <label className="req">Item Name</label>
                  <select className="input" value={line.item} onChange={(e) => pickItem(e.target.value)}>
                    <option value="">{ledgerItems.length ? `Select Item (${ledgerLabel(header.ledger)})` : `No active items in ${ledgerLabel(header.ledger)}`}</option>
                    {ledgerItems.map((it) => (
                      <option key={it._id} value={it._id}>
                        {it.code} – {it.name} (bal {fmtQty(balanceOf(it))})
                      </option>
                    ))}
                  </select>
                </div>
                <Field label="UoM" stack>
                  <input className="input" readOnly value={selected?.uom || ''} style={{ width: 80 }} />
                </Field>
                <Field label="Qty Issued" required stack>
                  <input className="input" type="number" min="0" step="any" value={line.qty} onChange={(e) => setLine({ ...line, qty: e.target.value })} style={{ width: 110 }} />
                </Field>
                <Field label="Ledger Page No." required stack>
                  <input className="input" value={line.ledgerPageNo} onChange={(e) => setLine({ ...line, ledgerPageNo: e.target.value })} style={{ width: 120 }} maxLength={30} />
                </Field>
                <Field label="Remarks" stack>
                  <input className="input" value={line.remarks} onChange={(e) => setLine({ ...line, remarks: e.target.value })} style={{ width: 180 }} maxLength={200} />
                </Field>
                <button type="button" className="btn btn-green" onClick={addLine}>
                  <Plus size={18} /> {editLine >= 0 ? 'Update' : 'Add Item'}
                </button>
                {selected && (
                  <div className="muted" style={{ width: '100%' }}>
                    {isLoan ? 'In Loan Store' : 'Available'}: <b>{fmtQty(available(line.item, editLine))} {selected.uom}</b>
                    {!isLoan && <> · Avg rate ₹{fmtMoney(selected.avgRate)}</>}
                  </div>
                )}
              </div>
            )}
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Sl.</th>
                    <th>Item Name</th>
                    <th>UoM</th>
                    <th className="num">Qty Issued</th>
                    {!isLoan && <th className="num">Amount (₹)</th>}
                    <th>Ledger Pg</th>
                    <th>Remarks</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => {
                    const it = itemById.get(l.item);
                    return (
                      <tr key={i} style={editLine === i ? { outline: '2px solid var(--yellow)' } : undefined}>
                        <td className="center">{i + 1}</td>
                        <td>{it ? it.name : '(inactive item)'}</td>
                        <td className="center">{it?.uom}</td>
                        <td className="num">{fmtQty(l.qty)}</td>
                        {!isLoan && <td className="num">{fmtMoney(l.qty * (it?.avgRate || 0))}</td>}
                        <td className="center">{l.ledgerPageNo}</td>
                        <td>
                          <input
                            className="inline-input"
                            value={l.remarks}
                            maxLength={200}
                            onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, remarks: e.target.value } : x)))}
                          />
                        </td>
                        <td className="center" style={{ whiteSpace: 'nowrap' }}>
                          <button type="button" className="icon-btn edit" title="Edit line" onClick={() => { setLine({ ...l, qty: String(l.qty) }); setEditLine(i); }}>
                            <Pencil size={18} />
                          </button>
                          <button type="button" className="icon-btn del" title="Remove line" onClick={() => setLines(lines.filter((_, j) => j !== i))}>
                            <Trash2 size={18} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                  {!lines.length && (
                    <tr>
                      <td colSpan={isLoan ? 7 : 8} className="empty">
                        No items added yet.
                      </td>
                    </tr>
                  )}
                </tbody>
                {!isLoan && (
                  <tfoot>
                    <tr>
                      <td colSpan={4} className="num">
                        Total Amount (₹)
                      </td>
                      <td className="num">{fmtMoney(total)}</td>
                      <td colSpan={3} className="muted" style={{ fontSize: 12, fontWeight: 500 }}>
                        Valued at weighted average rate
                      </td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
            <div style={{ marginTop: 10 }}>
              <Field label="Remarks">
                <input className="input" value={header.remarks} onChange={h('remarks')} maxLength={300} />
              </Field>
            </div>
          </Panel>
        </div>

        <div className="vch-side">
          <Panel title="Issue Options" icon={Settings2} light>
            <div style={{ display: 'grid', gap: 10 }}>
              <button type="button" className="btn btn-green btn-lg btn-block" disabled={!canWrite || busy} onClick={() => save(false)}>
                <Save size={20} /> {editId ? 'Update Issue' : 'Save Issue'}
              </button>
              <button type="button" className="btn btn-blue btn-lg btn-block" disabled={!canWrite || busy} onClick={() => save(true)}>
                <Printer size={20} /> Save & Print
              </button>
              <button type="button" className="btn btn-outline btn-lg btn-block" onClick={reset}>
                <RotateCcw size={20} /> Clear / Reset
              </button>
            </div>
          </Panel>
          <Panel title="Utilities" icon={Layers} light>
            <ul className="link-list">
              <li>
                <button type="button" onClick={() => setModal({ type: 'register', mode: 'view' })}>
                  <FileText size={20} /> View Issue Register <ChevronRight className="chev" size={20} />
                </button>
              </li>
              {canWrite && (
                <>
                  <li>
                    <button type="button" onClick={() => setModal({ type: 'register', mode: 'edit' })}>
                      <Pencil size={20} /> Edit Issue <ChevronRight className="chev" size={20} />
                    </button>
                  </li>
                  <li>
                    <button type="button" onClick={() => setModal({ type: 'register', mode: 'cancel' })}>
                      <XCircle size={20} color="var(--red-600)" /> Cancel Issue <ChevronRight className="chev" size={20} />
                    </button>
                  </li>
                </>
              )}
              <li>
                <button type="button" onClick={() => navigate('/loan?tab=receipt')}>
                  <ArrowLeftRight size={20} /> Return from Loan Store <ChevronRight className="chev" size={20} />
                </button>
              </li>
            </ul>
          </Panel>
        </div>
      </div>

      <Panel title="Recent Issues" icon={CalendarDays} light bodyClass="table-wrap">
        <table className="data">
          <RegisterHead kind="issue" />
          <tbody>
            <VoucherRows
              kind="issue"
              colSpan={9}
              rows={recent?.rows || []}
              onView={(v) => setModal({ type: 'view', id: v._id })}
              onPrint={(v) => setModal({ type: 'view', id: v._id, print: true })}
            />
          </tbody>
        </table>
      </Panel>

      {printer.node}
      {modal?.type === 'view' && <VoucherViewModal kind="issue" id={modal.id} autoPrint={modal.print} onClose={() => setModal(null)} />}
      {modal?.type === 'register' && (
        <RegisterModal
          kind="issue"
          mode={modal.mode}
          onClose={() => setModal(null)}
          onEdit={loadForEdit}
          onChanged={() => {
            reloadRecent();
            reloadItems();
            reloadLoan();
          }}
        />
      )}
    </>
  );
}
