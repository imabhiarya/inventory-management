import { useMemo, useState } from 'react';
import {
  Download, ClipboardList, Package, Plus, Pencil, Trash2, Save, Printer, RotateCcw, Settings2, Layers, FileText, XCircle,
  ChevronRight, CalendarDays,
} from 'lucide-react';
import { api } from '../api.js';
import { useApp } from '../context/AppContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { useFetch, useItems } from '../hooks.js';
import { PageHeader, Panel, Field, Select } from '../components/ui.jsx';
import LedgerPicker from '../components/LedgerPicker.jsx';
import { RegisterHead, RegisterModal, VoucherRows, VoucherViewModal, useVoucherPrinter } from '../components/vouchers.jsx';
import { fmtMoney, fmtQty, isoDay } from '../utils/format.js';

/** B/F: brought forward from the old manual ledger (no PO / sanction; Old Ledger Page instead of Old RV No.). */
const isBroughtForward = (receiptType) => (receiptType || '').replace(/[^a-z]/gi, '').toUpperCase() === 'BF';

const blankLine = { codeHead: '', item: '', qty: '', rate: '', ledgerPageNo: '' };

export default function Receipt() {
  const { meta, settings, canWrite, ledgerLabel } = useApp();
  const toast = useToast();
  const newHeader = () => ({
    date: meta.today,
    receiptType: settings.receiptTypes[0] || '',
    ledger: meta.ledgers[0]?.key || '',
    oldRvNo: '',
    loanStoreType: '',
    oldLedgerPage: '',
    source: '',
    poNo: '',
    poDate: '',
    remarks: '',
  });
  const [header, setHeader] = useState(newHeader);
  const [lines, setLines] = useState([]);
  const [line, setLine] = useState(blankLine);
  const [editLine, setEditLine] = useState(-1);
  const [editId, setEditId] = useState(null);
  const [editNo, setEditNo] = useState('');
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState(null); // {type:'register', mode} | {type:'view', id, print}
  const printer = useVoucherPrinter('receipt');

  const { data: itemsData } = useItems();
  const items = useMemo(() => itemsData?.items || [], [itemsData]);
  const itemById = useMemo(() => new Map(items.map((i) => [i._id, i])), [items]);
  const { data: nextNo, reload: reloadNo } = useFetch('/receipts/next-no', { ledger: header.ledger });
  // The Loan Store Ledger has no PO / sanction, code head or rate, and its own Loan Receipt No.
  const isLoan = header.ledger === 'LOAN';
  const loanStoreTypes = settings.loanStoreTypes?.length ? settings.loanStoreTypes : ['Furniture Store', 'T&P Store', 'Other Items'];
  const isBF = isBroughtForward(header.receiptType);
  const noPo = isLoan || isBF;
  const { data: recent, reload: reloadRecent } = useFetch('/receipts', { limit: 5, sort: 'entered' });

  const selected = itemById.get(line.item);

  // Selecting an item fills in its Ledger Page No. from the Item Master (still editable).
  const pickItem = (id) => setLine((l) => ({ ...l, item: id, ledgerPageNo: itemById.get(id)?.ledgerPage || '' }));
  const total = lines.reduce((s, l) => s + Number(l.qty) * Number(l.rate || 0), 0);


  const reset = () => {
    setHeader(newHeader());
    setLines([]);
    setLine(blankLine);
    setEditLine(-1);
    setEditId(null);
    setEditNo('');
  };

  const addLine = () => {
    if (!line.item) return toast.error('Select an item');
    if (!(Number(line.qty) > 0)) return toast.error('Enter the quantity received');
    if (line.rate !== '' && Number(line.rate) < 0) return toast.error('Rate cannot be negative');
    const l = { ...line, qty: Number(line.qty), rate: Number(line.rate || 0) };
    setLines((ls) => (editLine >= 0 ? ls.map((x, i) => (i === editLine ? l : x)) : [...ls, l]));
    setLine(blankLine);
    setEditLine(-1);
  };

  const save = async (print) => {
    if (!lines.length) return toast.error('Add at least one item');
    setBusy(true);
    try {
      const body = {
        ...header,
        lines: lines.map(({ item, codeHead, qty, rate, ledgerPageNo }) => ({ item, codeHead, qty, rate, ledgerPageNo })),
      };
      if (noPo) {
        body.poNo = '';
        delete body.poDate;
      }
      if (isBF) body.oldRvNo = '';
      else body.oldLedgerPage = '';
      const { receipt } = editId ? await api.put(`/receipts/${editId}`, body) : await api.post('/receipts', body);
      toast.success(`Receipt ${receipt.receiptNo} ${editId ? 'updated' : 'saved'}`);
      reset();
      reloadNo();
      reloadRecent();
      if (print) {
        try {
          await printer.printNow(receipt._id);
        } catch {
          toast.error('Saved, but the voucher could not be printed. Use Print in the voucher window.');
        }
        setModal({ type: 'view', id: receipt._id }); // stays open with a Print button for reprints
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
      const { receipt } = await api.get(`/receipts/${id}`);
      setEditId(receipt._id);
      setEditNo(receipt.receiptNo);
      setHeader({
        date: isoDay(receipt.date),
        receiptType: receipt.receiptType,
        ledger: receipt.ledger,
        oldRvNo: receipt.oldRvNo || '',
        loanStoreType: receipt.loanStoreType || '',
        oldLedgerPage: receipt.oldLedgerPage || '',
        source: receipt.source,
        poNo: receipt.poNo,
        poDate: isoDay(receipt.poDate),
        remarks: receipt.remarks || '',
      });
      setLines(receipt.lines.map((l) => ({ ...l, item: l.item._id })));
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      toast.error(e.message);
    }
  };

  const h = (k) => (v) => setHeader((s) => ({ ...s, [k]: v?.target ? v.target.value : v }));
  // Only items registered in the selected Type of Store / Ledger can go on this voucher.
  const ledgerItems = useMemo(() => items.filter((it) => it.ledger === header.ledger), [items, header.ledger]);

  return (
    <>
      <PageHeader icon={Download} title="Receipt (Goods Receipt)" />
      <div className="with-aside">
        <div>
          <Panel title={editId ? `Edit Receipt ${editNo}` : 'Receipt Entry'} icon={ClipboardList}>
            {/* Two independent columns, so hidden PO fields (B/F, Loan Store) leave no gaps. */}
            <div className="grid-2">
              <div className="form-col">
                <Field label="Type of Store / Ledger" required>
                  <LedgerPicker
                    value={header.ledger}
                    onChange={(v) => {
                      // Loan Store Ledger: start on the first Type of Loan Store; other ledgers have none.
                      setHeader((s) => ({ ...s, ledger: v, loanStoreType: v === 'LOAN' ? s.loanStoreType || loanStoreTypes[0] || '' : '' }));
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
                <Field label="Receipt Type" required>
                  <Select
                    value={header.receiptType}
                    onChange={(v) =>
                      // B/F stock comes from the old manual ledger: suggest that as the source (still editable).
                      setHeader((s) => ({ ...s, receiptType: v, source: isBroughtForward(v) && !s.source ? 'Old Ledger' : s.source }))
                    }
                    options={settings.receiptTypes}
                  />
                </Field>
                <Field label={isLoan ? 'Loan Receipt No.' : 'Receipt No.'} required>
                  <input className="input" readOnly value={editId ? editNo : nextNo?.next || ''} title="Assigned automatically when saved" />
                </Field>
                {isBF ? (
                  <Field label="Old Ledger Page">
                    <input className="input" value={header.oldLedgerPage} onChange={h('oldLedgerPage')} placeholder="Enter Old Ledger Page (manual)" maxLength={40} />
                  </Field>
                ) : (
                  <Field label="Old RV No.">
                    <input className="input" value={header.oldRvNo} onChange={h('oldRvNo')} placeholder="Enter Old RV No. (manual)" maxLength={40} />
                  </Field>
                )}
              </div>
              <div className="form-col">
                {!noPo && (
                  <>
                    <Field label="PO / Sanction No." required>
                      <input className="input" value={header.poNo} onChange={h('poNo')} placeholder="PO/2025-26/0187" maxLength={80} />
                    </Field>
                    <Field label="PO / Sanction Date" required>
                      <input
                        className="input"
                        type="date"
                        value={header.poDate}
                        max={header.date || meta.today}
                        onChange={h('poDate')}
                        title="Date on which the PO / sanction was issued"
                      />
                    </Field>
                  </>
                )}
                <Field label="Receipt Date" required>
                  <input className="input" type="date" value={header.date} max={meta.today} onChange={h('date')} />
                </Field>
                <Field label="Source / From" required>
                  <input
                    className="input"
                    list="sources"
                    value={header.source}
                    onChange={h('source')}
                    placeholder={isBF ? 'Old Ledger (manual)' : 'Unit / Formation / Firm'}
                    maxLength={160}
                  />
                  <datalist id="sources">
                    {settings.sources.map((s) => (
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
                {!isLoan && (
                  <Field label="Code Head" stack>
                    <Select
                      value={line.codeHead}
                      onChange={(v) => setLine({ ...line, codeHead: v })}
                      placeholder="— Select —"
                      options={settings.codeHeads.map((c) => ({ value: c.code, label: `${c.code} – ${c.name}` }))}
                    />
                  </Field>
                )}
                <div className="field stack grow">
                  <label className="req">Item Name</label>
                  <select className="input" value={line.item} onChange={(e) => pickItem(e.target.value)}>
                    <option value="">{ledgerItems.length ? `Select Item (${ledgerLabel(header.ledger)})` : `No active items in ${ledgerLabel(header.ledger)}`}</option>
                    {ledgerItems.map((it) => (
                      <option key={it._id} value={it._id}>
                        {it.code} – {it.name}
                      </option>
                    ))}
                  </select>
                </div>
                <Field label="UoM" stack>
                  <input className="input" readOnly value={selected?.uom || ''} style={{ width: 80 }} />
                </Field>
                <Field label="Qty Received" required stack>
                  <input className="input" type="number" min="0" step="any" value={line.qty} onChange={(e) => setLine({ ...line, qty: e.target.value })} style={{ width: 110 }} />
                </Field>
                {!isLoan && (
                  <Field label="Rate (₹)" stack>
                    <input className="input" type="number" min="0" step="0.01" value={line.rate} onChange={(e) => setLine({ ...line, rate: e.target.value })} style={{ width: 110 }} />
                  </Field>
                )}
                <Field label="Ledger Page No." stack>
                  <input className="input highlight" value={line.ledgerPageNo} onChange={(e) => setLine({ ...line, ledgerPageNo: e.target.value })} style={{ width: 110 }} maxLength={30} />
                </Field>
                <button type="button" className="btn btn-green" onClick={addLine}>
                  <Plus size={18} /> {editLine >= 0 ? 'Update' : 'Add Item'}
                </button>
              </div>
            )}
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Sl.</th>
                    {!isLoan && <th>Code Head</th>}
                    <th>Item Name</th>
                    <th>UoM</th>
                    <th className="num">Qty</th>
                    {!isLoan && <th className="num">Rate (₹)</th>}
                    {!isLoan && <th className="num">Amount (₹)</th>}
                    <th>Ledger Pg</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => {
                    const it = itemById.get(l.item);
                    return (
                      <tr key={i} style={editLine === i ? { outline: '2px solid var(--yellow)' } : undefined}>
                        <td className="center">{i + 1}</td>
                        {!isLoan && <td className="center">{l.codeHead}</td>}
                        <td>{it ? it.name : '(inactive item)'}</td>
                        <td className="center">{it?.uom}</td>
                        <td className="num">{fmtQty(l.qty)}</td>
                        {!isLoan && <td className="num">{fmtMoney(l.rate)}</td>}
                        {!isLoan && <td className="num">{fmtMoney(l.qty * l.rate)}</td>}
                        <td className="center">{l.ledgerPageNo}</td>
                        <td className="center" style={{ whiteSpace: 'nowrap' }}>
                          <button type="button" className="icon-btn edit" title="Edit line" onClick={() => { setLine({ ...l, qty: String(l.qty), rate: String(l.rate) }); setEditLine(i); }}>
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
                      <td colSpan={isLoan ? 6 : 9} className="empty">
                        No items added yet.
                      </td>
                    </tr>
                  )}
                </tbody>
                {!isLoan && (
                  <tfoot>
                    <tr>
                      <td colSpan={6} className="num">
                        Total Amount (₹)
                      </td>
                      <td className="num">{fmtMoney(total)}</td>
                      <td colSpan={2} />
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
          <Panel title="Receipt Options" icon={Settings2} light>
            <div style={{ display: 'grid', gap: 10 }}>
              <button type="button" className="btn btn-green btn-lg btn-block" disabled={!canWrite || busy} onClick={() => save(false)}>
                <Save size={20} /> {editId ? 'Update Receipt' : 'Save Receipt'}
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
                  <FileText size={20} /> View Receipt Register <ChevronRight className="chev" size={20} />
                </button>
              </li>
              {canWrite && (
                <>
                  <li>
                    <button type="button" onClick={() => setModal({ type: 'register', mode: 'edit' })}>
                      <Pencil size={20} /> Edit Receipt <ChevronRight className="chev" size={20} />
                    </button>
                  </li>
                  <li>
                    <button type="button" onClick={() => setModal({ type: 'register', mode: 'cancel' })}>
                      <XCircle size={20} color="var(--red-600)" /> Cancel Receipt <ChevronRight className="chev" size={20} />
                    </button>
                  </li>
                </>
              )}
            </ul>
          </Panel>
        </div>
      </div>

      <Panel title="Recent Receipts" icon={CalendarDays} light bodyClass="table-wrap">
        <table className="data">
          <RegisterHead kind="receipt" />
          <tbody>
            <VoucherRows
              kind="receipt"
              colSpan={10}
              rows={recent?.rows || []}
              onView={(v) => setModal({ type: 'view', id: v._id })}
              onPrint={(v) => setModal({ type: 'view', id: v._id, print: true })}
            />
          </tbody>
        </table>
      </Panel>

      {printer.node}
      {modal?.type === 'view' && <VoucherViewModal kind="receipt" id={modal.id} autoPrint={modal.print} onClose={() => setModal(null)} />}
      {modal?.type === 'register' && (
        <RegisterModal
          kind="receipt"
          mode={modal.mode}
          onClose={() => setModal(null)}
          onEdit={loadForEdit}
          onChanged={() => {
            reloadRecent();
          }}
        />
      )}
    </>
  );
}
