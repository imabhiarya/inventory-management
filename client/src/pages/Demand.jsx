import { useMemo, useState } from 'react';
import { ClipboardPen, ClipboardList, Plus, Trash2, Save, RotateCcw, Printer, Pencil, Eye, Search, X, Layers, FileSpreadsheet } from 'lucide-react';
import ConsolidatedDemand from './ConsolidatedDemand.jsx';
import DcsPage from './Dcs.jsx';
import { api } from '../api.js';
import { useApp } from '../context/AppContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { useFetch, useItems } from '../hooks.js';
import { PageHeader, Panel, Field, Select, Modal } from '../components/ui.jsx';
import { fmtDate, fmtQty, fmtMoney, numberToWords } from '../utils/format.js';
import { printSection } from '../utils/export.js';

const DEFAULT_SUB_SECTIONS = ['Admin', 'Works', 'Accounts', 'Stores', 'B/R', 'E/M', 'MT'];
const DEFAULT_FREQUENCIES = ['Regular', 'Monthly', 'Quarterly', 'Half Yearly', 'Annual', 'Urgent'];
const blankLine = { item: '', qty: '', rate: '', remarks: '' };
const listOf = (settings, key, fallback) => (settings[key]?.length ? settings[key] : fallback);
const withCurrent = (list, value) => (value && !list.includes(value) ? [value, ...list] : list);

/**
 * Printed demand form (print only): office heading, demand details, items, authority, a request line
 * and signature blocks.
 */
function DemandPrint({ demand }) {
  const { settings, ledgerLabel } = useApp();
  // Rate / Amount columns appear only when at least one item was given a rate.
  const withRate = demand.lines.some((l) => l.rate > 0);
  const total = demand.lines.reduce((s, l) => s + (l.rate || 0) * l.qty, 0);
  const cols = withRate ? 8 : 6;
  return (
    <div className="print-doc demand-print" id="demand-print">
      <div className="voucher-head">
        <div className="voucher-form-no">Demand No.: {demand.demandNo}</div>
        <h4 className="voucher-title">DEMAND / INDENT FOR STORES</h4>
        <div className="voucher-unit" style={{ textAlign: 'center', marginTop: 4 }}>
          {settings.orgTitle}
        </div>
      </div>
      <div className="doc-meta plain">
        <div>Demand No.: {demand.demandNo}</div>
        <div>Date: {fmtDate(demand.date)}</div>
        <div>Unit: {demand.unit}</div>
        <div>Sub Section: {demand.subSection || '—'}</div>
        <div>Frequency: {demand.frequency || 'Regular'}</div>
      </div>
      <p className="demand-to">
        To,
        <br />
        {demand.demandedTo || `The Store Officer, ${settings.storeName}`}
      </p>
      <p>
        The following stores are demanded for the use of {demand.unit}
        {demand.subSection ? ` (${demand.subSection})` : ''}:
      </p>
      <table className="data">
        <thead>
          <tr>
            <th>Sl.</th>
            <th>Item Name</th>
            <th>Ledger</th>
            <th>A/U</th>
            <th className="num">Qty Demanded</th>
            {withRate && <th className="num">Rate (₹)</th>}
            {withRate && <th className="num">Amount (₹)</th>}
            <th>Remarks</th>
          </tr>
        </thead>
        <tbody>
          {demand.lines.map((l, i) => (
            <tr key={i}>
              <td className="center">{i + 1}</td>
              <td>
                {l.item?.name}
                {l.item?.description && <div className="item-desc">{l.item.description}</div>}
              </td>
              <td>{l.item?.ledger ? ledgerLabel(l.item.ledger) : ''}</td>
              <td className="center">{l.item?.uom}</td>
              <td className="num">{fmtQty(l.qty)}</td>
              {withRate && <td className="num">{l.rate ? fmtMoney(l.rate) : '-'}</td>}
              {withRate && <td className="num">{l.rate ? fmtMoney(l.rate * l.qty) : '-'}</td>}
              <td>{l.remarks}</td>
            </tr>
          ))}
          {withRate && (
            <tr className="voucher-count">
              <td colSpan={6} className="num">
                Total Amount (₹)
              </td>
              <td className="num">{fmtMoney(total)}</td>
              <td />
            </tr>
          )}
          <tr className="voucher-count">
            <td colSpan={cols}>
              Total Items: {demand.lines.length} ({numberToWords(demand.lines.length)} Only)
            </td>
          </tr>
        </tbody>
      </table>
      <div className="doc-meta plain" style={{ marginTop: 10 }}>
        <div>Authority: {demand.authority || '—'}</div>
        {demand.remarks && <div>Remarks: {demand.remarks}</div>}
      </div>
      <p className="demand-request">
        It is requested that the above stores may kindly be issued at the earliest, as they are required for the smooth functioning of the
        office. The stores will be used for official purposes only and accounted for as per the existing orders.
      </p>
      <div className="doc-sign demand-sign">
        <div>
          Demanded By
          <small>({demand.subSection || demand.unit})</small>
        </div>
        <div>
          Countersigned / Approved By
          <small>({demand.authority || 'Officer In-Charge'})</small>
        </div>
        <div>
          Store Keeper
          <small>(Issued / Received)</small>
        </div>
      </div>
    </div>
  );
}

/** Demand entry / edit form. */
function DemandForm({ editing, onSaved, onCancel }) {
  const { meta, settings, canWrite, ledgerLabel } = useApp();
  const toast = useToast();
  const { data: itemsData } = useItems();
  const items = useMemo(() => itemsData?.items || [], [itemsData]);
  const itemById = useMemo(() => new Map(items.map((i) => [i._id, i])), [items]);
  const { data: nextNo } = useFetch('/demands/next-no');
  const [h, setH] = useState(() =>
    editing
      ? {
          date: String(editing.date).slice(0, 10),
          unit: editing.unit,
          subSection: editing.subSection,
          authority: editing.authority,
          remarks: editing.remarks,
          demandedTo: editing.demandedTo || '',
          frequency: editing.frequency || 'Regular',
        }
      : { date: meta.today, unit: '', subSection: '', authority: '', remarks: '', demandedTo: '', frequency: 'Regular' },
  );
  const [lines, setLines] = useState(() =>
    editing ? editing.lines.map((l) => ({ item: l.item?._id || l.item, qty: l.qty, rate: l.rate || '', remarks: l.remarks })) : [],
  );
  const [line, setLine] = useState(blankLine);
  const [busy, setBusy] = useState(false);
  const set = (k) => (v) => setH((s) => ({ ...s, [k]: v?.target ? v.target.value : v }));
  const selected = itemById.get(line.item);

  // Items of every ledger, grouped by ledger in the picker.
  const groups = useMemo(() => {
    const m = new Map();
    for (const it of items) {
      if (!m.has(it.ledger)) m.set(it.ledger, []);
      m.get(it.ledger).push(it);
    }
    return [...m.entries()];
  }, [items]);

  const addLine = () => {
    if (!line.item) return toast.error('Select an item');
    if (!(Number(line.qty) > 0)) return toast.error('Enter the quantity demanded');
    if (lines.some((l) => l.item === line.item)) return toast.error('This item is already on the demand');
    if (line.rate !== '' && Number(line.rate) < 0) return toast.error('Rate cannot be negative');
    setLines((ls) => [...ls, { ...line, qty: Number(line.qty), rate: line.rate === '' ? '' : Number(line.rate) }]);
    setLine(blankLine);
  };
  const save = async (print) => {
    if (!h.unit) return toast.error('Select the Unit');
    if (!lines.length) return toast.error('Add at least one item');
    setBusy(true);
    try {
      const body = { ...h, lines: lines.map((l) => ({ ...l, rate: Number(l.rate || 0) })) };
      const { demand } = editing ? await api.put(`/demands/${editing._id}`, body) : await api.post('/demands', body);
      toast.success(`Demand ${demand.demandNo} ${editing ? 'updated' : 'saved'}`);
      onSaved(demand, print);
      if (!editing) {
        setLines([]);
        setH((s) => ({ ...s, remarks: '' }));
      }
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title={editing ? `Edit Demand ${editing.demandNo}` : 'Demand Entry'} icon={ClipboardPen}>
      <div className="grid-2">
        <div className="form-col">
          <Field label="Demand No." required>
            <input
              className="input"
              readOnly
              value={editing ? editing.demandNo : nextNo?.next || ''}
              title="Assigned automatically when saved"
            />
          </Field>
          <Field label="Unit" required>
            <Select
              className="input highlight"
              value={h.unit}
              onChange={set('unit')}
              placeholder="— Select Unit —"
              options={withCurrent(settings.units, h.unit)}
            />
          </Field>
          <Field label="Sub Section">
            <Select
              value={h.subSection}
              onChange={set('subSection')}
              placeholder="— Select —"
              options={withCurrent(listOf(settings, 'demandSubSections', DEFAULT_SUB_SECTIONS), h.subSection)}
            />
          </Field>
          <Field label="Demand Frequency">
            <Select
              value={h.frequency}
              onChange={set('frequency')}
              options={withCurrent(listOf(settings, 'demandFrequencies', DEFAULT_FREQUENCIES), h.frequency)}
            />
          </Field>
        </div>
        <div className="form-col">
          <Field label="Demand Date" required>
            <input className="input" type="date" value={h.date} onChange={set('date')} />
          </Field>
          <Field label="Authority">
            <input
              className="input"
              value={h.authority}
              onChange={set('authority')}
              maxLength={160}
              placeholder="Type the authority (e.g. AGE (B/R) letter no. / approval)"
            />
          </Field>
          <Field label="Remarks">
            <input className="input" value={h.remarks} onChange={set('remarks')} maxLength={500} />
          </Field>
          <Field label="Demanded To">
            <input
              className="input"
              value={h.demandedTo}
              onChange={set('demandedTo')}
              maxLength={200}
              placeholder={`e.g. The Store Officer, ${settings.storeName}`}
            />
          </Field>
        </div>
      </div>

      <h5 className="audit-h" style={{ marginTop: 14 }}>
        Items Demanded (any ledger)
      </h5>
      {canWrite && (
        <div className="filters" style={{ marginBottom: 10 }}>
          <div className="field stack grow">
            <label className="req">Item Name</label>
            <select className="input" value={line.item} onChange={(e) => setLine({ ...line, item: e.target.value })}>
              <option value="">{items.length ? 'Select Item' : 'No items registered yet'}</option>
              {groups.map(([ledger, list]) => (
                <optgroup key={ledger} label={ledgerLabel(ledger)}>
                  {list.map((it) => (
                    <option key={it._id} value={it._id}>
                      {it.code} – {it.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          <Field label="A/U" stack>
            <input className="input" readOnly value={selected?.uom || ''} style={{ width: 80 }} />
          </Field>
          <Field label="Qty Demanded" required stack>
            <input
              className="input"
              type="number"
              min="0"
              step="any"
              value={line.qty}
              onChange={(e) => setLine({ ...line, qty: e.target.value })}
              style={{ width: 120 }}
            />
          </Field>
          <Field label="Rate (₹) – optional" stack>
            <input
              className="input"
              type="number"
              min="0"
              step="any"
              value={line.rate}
              onChange={(e) => setLine({ ...line, rate: e.target.value })}
              style={{ width: 130 }}
            />
          </Field>
          <Field label="Remarks" stack>
            <input
              className="input"
              value={line.remarks}
              onChange={(e) => setLine({ ...line, remarks: e.target.value })}
              maxLength={200}
              style={{ width: 180 }}
            />
          </Field>
          <button type="button" className="btn btn-green" onClick={addLine}>
            <Plus size={18} /> Add Item
          </button>
          {selected && (
            <div className="muted" style={{ width: '100%' }}>
              {ledgerLabel(selected.ledger)} · In store:{' '}
              <b>
                {fmtQty(selected.currentStock ?? 0)} {selected.uom}
              </b>
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
              <th>Ledger</th>
              <th>A/U</th>
              <th className="num">Qty Demanded</th>
              <th className="num">Rate (₹)</th>
              <th>Remarks</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const it = itemById.get(l.item);
              return (
                <tr key={l.item}>
                  <td className="center">{i + 1}</td>
                  <td>{it ? it.name : '…'}</td>
                  <td>{it ? ledgerLabel(it.ledger) : ''}</td>
                  <td className="center">{it?.uom}</td>
                  <td className="num">{fmtQty(l.qty)}</td>
                  <td className="num">{l.rate ? fmtMoney(l.rate) : '-'}</td>
                  <td>{l.remarks}</td>
                  <td className="center">
                    <button
                      type="button"
                      className="icon-btn del"
                      title="Remove"
                      onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}
                    >
                      <Trash2 size={16} />
                    </button>
                  </td>
                </tr>
              );
            })}
            {!lines.length && (
              <tr>
                <td colSpan={8} className="empty">
                  No items added yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {canWrite && (
        <div className="row" style={{ gap: 10, justifyContent: 'center', marginTop: 12 }}>
          <button type="button" className="btn btn-green btn-lg" disabled={busy} onClick={() => save(false)}>
            <Save size={18} /> {editing ? 'Save Changes' : 'Save Demand'}
          </button>
          <button type="button" className="btn btn-blue btn-lg" disabled={busy} onClick={() => save(true)}>
            <Printer size={18} /> Save &amp; Print
          </button>
          <button
            type="button"
            className="btn btn-outline btn-lg"
            onClick={() => {
              if (editing) return onCancel();
              setLines([]);
              setLine(blankLine);
              setH({ date: meta.today, unit: '', subSection: '', authority: '', remarks: '', demandedTo: '', frequency: 'Regular' });
            }}
          >
            <RotateCcw size={18} /> {editing ? 'Cancel Edit' : 'Clear'}
          </button>
        </div>
      )}
    </Panel>
  );
}

/** Demand (indent) page: raise demands for items of any ledger and print the demand form. */
export default function DemandPage() {
  const { settings, canWrite, isAdmin } = useApp();
  const toast = useToast();
  const [f, setF] = useState({ from: '', to: '', unit: '', q: '' });
  const [applied, setApplied] = useState(f);
  const { data, loading, reload } = useFetch('/demands', applied);
  const rows = data?.rows || [];
  const [editing, setEditing] = useState(null);
  const [viewing, setViewing] = useState(null); // demand shown (and printable)
  const [removing, setRemoving] = useState(null);
  const [tab, setTab] = useState('entry');

  const printDemand = (d) => {
    setViewing(d);
    setTimeout(() => printSection('demand-print'), 150);
  };

  return (
    <>
      <PageHeader icon={ClipboardPen} plainIcon title="Demand (Indent)" />
      <div className="tabs">
        <button
          type="button"
          className={`tab ${tab === 'entry' ? 'active' : ''}`}
          onClick={() => {
            setTab('entry');
            reload(); // pick up "Consolidated" marks made on the other tab
          }}
        >
          <ClipboardPen size={20} /> Section Demand
        </button>
        <button
          type="button"
          className={`tab ${tab === 'consolidated' ? 'active' : ''}`}
          onClick={() => {
            setTab('consolidated');
          }}
        >
          <Layers size={20} /> Consolidated Demand
        </button>
        <button type="button" className={`tab ${tab === 'dcs' ? 'active' : ''}`} onClick={() => setTab('dcs')}>
          <FileSpreadsheet size={20} /> DCS
        </button>
      </div>
      {tab === 'dcs' ? (
        <DcsPage />
      ) : tab === 'consolidated' ? (
        <ConsolidatedDemand />
      ) : (
        <>
          <DemandForm
            key={editing?._id || 'new'}
            editing={editing}
            onCancel={() => setEditing(null)}
            onSaved={(d, print) => {
              setEditing(null);
              reload();
              if (print) printDemand(d);
            }}
          />

          <Panel title="Demand Register" icon={ClipboardList}>
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
              <Field label="Unit" stack>
                <Select value={f.unit} onChange={(v) => setF({ ...f, unit: v })} placeholder="All" options={settings.units} />
              </Field>
              <div className="field stack grow">
                <label>Search</label>
                <input
                  className="input"
                  value={f.q}
                  onChange={(e) => setF({ ...f, q: e.target.value })}
                  placeholder="Demand no., sub section, authority, remarks"
                />
              </div>
              <button className="btn btn-blue">
                <Search size={18} /> View
              </button>
            </form>
            <div className="table-wrap" style={{ marginTop: 10 }}>
              <table className="data">
                <thead>
                  <tr>
                    <th>Sl.</th>
                    <th>Demand No.</th>
                    <th>Date</th>
                    <th>Unit</th>
                    <th>Sub Section</th>
                    <th>Frequency</th>
                    <th>Authority</th>
                    <th>No. of Items</th>
                    <th>Consolidated</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((d, i) => (
                    <tr key={d._id}>
                      <td className="center">{i + 1}</td>
                      <td className="center">{d.demandNo}</td>
                      <td className="center">{fmtDate(d.date)}</td>
                      <td>{d.unit}</td>
                      <td>{d.subSection || '-'}</td>
                      <td className="center">{d.frequency || 'Regular'}</td>
                      <td>{d.authority || '-'}</td>
                      <td className="center">{d.lines.length}</td>
                      <td className="center">
                        {d.consolidatedIn?.no ? <span className="badge badge-blue">{d.consolidatedIn.no}</span> : '-'}
                      </td>
                      <td className="center" style={{ whiteSpace: 'nowrap' }}>
                        <button type="button" className="icon-btn" title="View" onClick={() => setViewing(d)}>
                          <Eye size={18} />
                        </button>
                        <button type="button" className="icon-btn" title="Print" onClick={() => printDemand(d)}>
                          <Printer size={18} />
                        </button>
                        {canWrite && (
                          <button
                            type="button"
                            className="icon-btn edit"
                            title="Edit"
                            onClick={() => {
                              setEditing(d);
                              window.scrollTo({ top: 0, behavior: 'smooth' });
                            }}
                          >
                            <Pencil size={18} />
                          </button>
                        )}
                        {isAdmin && (
                          <button type="button" className="icon-btn del" title="Delete" onClick={() => setRemoving(d)}>
                            <Trash2 size={18} />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {!rows.length && (
                    <tr>
                      <td colSpan={10} className="empty">
                        {loading ? 'Loading…' : 'No demands yet.'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Panel>
        </>
      )}

      {viewing && (
        <Modal
          printable
          title={`Demand ${viewing.demandNo}`}
          size="lg"
          onClose={() => setViewing(null)}
          footer={
            <button type="button" className="btn btn-blue" onClick={() => printSection('demand-print')}>
              <Printer size={18} /> Print
            </button>
          }
        >
          {/* On screen: a compact summary. The full demand form below appears only on paper. */}
          <div className="audit-meta">
            <div>
              <span>Date</span> {fmtDate(viewing.date)}
            </div>
            <div>
              <span>Unit</span> <b>{viewing.unit}</b>
            </div>
            <div>
              <span>Sub Section</span> {viewing.subSection || '—'}
            </div>
            <div>
              <span>Authority</span> {viewing.authority || '—'}
            </div>
            <div className="wide">
              <span>Remarks</span> {viewing.remarks || '—'}
            </div>
          </div>
          <table className="data" style={{ marginTop: 10 }}>
            <thead>
              <tr>
                <th>Sl.</th>
                <th>Item Name</th>
                <th>A/U</th>
                <th className="num">Qty Demanded</th>
                <th>Remarks</th>
              </tr>
            </thead>
            <tbody>
              {viewing.lines.map((l, i) => (
                <tr key={i}>
                  <td className="center">{i + 1}</td>
                  <td>{l.item?.name}</td>
                  <td className="center">{l.item?.uom}</td>
                  <td className="num">{fmtQty(l.qty)}</td>
                  <td>{l.remarks}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <DemandPrint demand={viewing} />
        </Modal>
      )}
      {removing && (
        <Modal
          title={`Delete demand ${removing.demandNo}?`}
          size="sm"
          onClose={() => setRemoving(null)}
          footer={
            <>
              <button type="button" className="btn btn-ghost" onClick={() => setRemoving(null)}>
                <X size={16} /> Keep
              </button>
              <button
                type="button"
                className="btn btn-red"
                onClick={async () => {
                  try {
                    await api.del(`/demands/${removing._id}`);
                    toast.success(`${removing.demandNo} deleted`);
                    setRemoving(null);
                    reload();
                  } catch (e) {
                    toast.error(e.message);
                  }
                }}
              >
                <Trash2 size={16} /> Delete
              </button>
            </>
          }
        >
          This removes the demand record. Stock is not affected.
        </Modal>
      )}
    </>
  );
}
