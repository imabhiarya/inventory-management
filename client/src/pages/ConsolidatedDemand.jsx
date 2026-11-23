import { useMemo, useState } from 'react';
import { Layers, Search, Plus, Trash2, Save, Printer, RotateCcw, Eye, Pencil, X, ClipboardList, Combine } from 'lucide-react';
import { api } from '../api.js';
import { useApp } from '../context/AppContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { useFetch, useItems } from '../hooks.js';
import { Panel, Field, Select, Modal } from '../components/ui.jsx';
import { fmtDate, fmtQty, fmtMoney, numberToWords } from '../utils/format.js';
import { printSection } from '../utils/export.js';
import { SignatureBlocks } from './Dcs.jsx';

const DEFAULT_FREQUENCIES = ['Regular', 'Monthly', 'Quarterly', 'Half Yearly', 'Annual', 'Urgent'];
const blankHead = (today) => ({ date: today, forwardedTo: '', subject: '', frequency: 'Regular', codeHead: '', authority: '', remarks: '' });
const blankLine = { item: '', qty: '', rate: '', remarks: '' };
const shareText = (b) => b.map((s) => `${s.unit}${s.subSection ? ` (${s.subSection})` : ''}: ${fmtQty(s.qty)}`).join(', ');

/** Combine section demands: one line per item with the total and who asked for how much. */
function combine(demands) {
  const byItem = new Map();
  for (const d of demands)
    for (const l of d.lines) {
      const id = l.item?._id || l.item;
      if (!byItem.has(id)) byItem.set(id, { item: id, qty: 0, rate: '', remarks: '', breakdown: [] });
      const row = byItem.get(id);
      row.qty += l.qty;
      if (!row.rate && l.rate) row.rate = l.rate;
      row.breakdown.push({ demandNo: d.demandNo, unit: d.unit, subSection: d.subSection || '', qty: l.qty });
    }
  return [...byItem.values()].map((r) => ({ ...r, qty: Math.round(r.qty * 1000) / 1000 }));
}

/** Printed consolidated demand (paper only). */
function ConsolidatedPrint({ cd }) {
  const { settings } = useApp();
  const withRate = cd.lines.some((l) => l.rate > 0);
  const total = cd.lines.reduce((s, l) => s + (l.rate || 0) * l.qty, 0);
  const cols = withRate ? 7 : 5;
  const shared = cd.lines.filter((l) => l.breakdown?.length);
  return (
    <div className="print-doc demand-print" id="cd-print">
      {/* Heading in the office's demand format. */}
      <h4 className="cd-title">DEMAND OF STORE : STATIONARY/T&amp;P ITEMS/OFFICE CONTINGENCY</h4>
      <div className="cd-head">
        <div>
          UNIT: <b>{settings.orgTitle}</b>
        </div>
        <div>
          DEMAND NO: <b>{cd.cdNo}</b>
        </div>
        <div>
          DEMAND DATE: <b>{fmtDate(cd.date)}</b>
        </div>
        <div>
          FREQUENCY: <b>{cd.frequency || 'Regular'}</b>
        </div>
        {/* TO SECTION on the left, CODE HEAD in the space on the right. */}
        <div>
          TO SECTION: <b>{cd.forwardedTo || ''}</b>
        </div>
        <div>
          {cd.codeHead && (
            <>
              CODE HEAD: <b>{cd.codeHead}</b>
            </>
          )}
        </div>
        <div className="wide">
          AUTH: <b>{cd.authority || ''}</b>
        </div>
        {cd.subject && (
          <div className="wide">
            SUBJECT: <b>{cd.subject}</b>
          </div>
        )}
      </div>
      <p>The following stores, consolidated from the demands of the sections, are required to be procured:</p>
      <table className="data cd-table">
        <thead>
          <tr>
            <th>Sl.</th>
            <th className="cd-item">Item Name</th>
            <th>A/U</th>
            <th className="num">Total Qty</th>
            {withRate && <th className="num">Rate (₹)</th>}
            {withRate && <th className="num">Amount (₹)</th>}
            <th>Remarks</th>
          </tr>
        </thead>
        <tbody>
          {cd.lines.map((l, i) => (
            <tr key={i}>
              <td className="center">{i + 1}</td>
              <td>
                {l.item?.name}
                {l.item?.description && <div className="item-desc">{l.item.description}</div>}
              </td>
              <td className="center">{l.item?.uom}</td>
              <td className="num">{fmtQty(l.qty)}</td>
              {withRate && <td className="num">{l.rate ? fmtMoney(l.rate) : '-'}</td>}
              {withRate && <td className="num">{l.rate ? fmtMoney(l.rate * l.qty) : '-'}</td>}
              <td>{l.remarks}</td>
            </tr>
          ))}
          {withRate && (
            <tr className="voucher-count">
              <td colSpan={5} className="num">
                Total Amount (₹)
              </td>
              <td className="num">{fmtMoney(total)}</td>
              <td />
            </tr>
          )}
          <tr className="voucher-count">
            <td colSpan={cols}>
              Total Items: {cd.lines.length} ({numberToWords(cd.lines.length)} Only)
            </td>
          </tr>
        </tbody>
      </table>
      {/* Note: who demanded how much of each item (section-wise). */}
      {shared.length > 0 && (
        <div className="cd-note">
          <b>Note – Demanded by sections:</b>
          <ol>
            {cd.lines.map((l, i) =>
              l.breakdown?.length ? (
                <li key={i} value={i + 1}>
                  <b>{l.item?.name}</b>: {shareText(l.breakdown)}
                </li>
              ) : null,
            )}
          </ol>
        </div>
      )}
      <div className="doc-meta plain" style={{ marginTop: 10 }}>
        <div>Consolidated from section demands: {(cd.sourceDemands || []).map((x) => x.demandNo).join(', ') || '—'}</div>
        {cd.remarks && <div>Remarks: {cd.remarks}</div>}
      </div>
      <p className="demand-request">
        The above requirement has been consolidated from the demands received from the sections and is forwarded for necessary
        procurement action, please, so that the smooth functioning of the office is maintained.
      </p>
      <SignatureBlocks />
    </div>
  );
}

/** Demand → Consolidated Demand tab. */
export default function ConsolidatedDemand() {
  const { meta, settings, canWrite, isAdmin, ledgerLabel } = useApp();
  const toast = useToast();
  const frequencies = settings.demandFrequencies?.length ? settings.demandFrequencies : DEFAULT_FREQUENCIES;
  const codeHeads = settings.orderCodeHeads?.length ? settings.orderCodeHeads : settings.codeHeads.map((c) => (c.name ? `${c.code} – ${c.name}` : c.code));
  const { data: itemsData } = useItems();
  const items = useMemo(() => itemsData?.items || [], [itemsData]);
  const itemById = useMemo(() => new Map(items.map((i) => [i._id, i])), [items]);
  const groups = useMemo(() => {
    const m = new Map();
    for (const it of items) (m.get(it.ledger) || m.set(it.ledger, []).get(it.ledger)).push(it);
    return [...m.entries()];
  }, [items]);

  // Step 1: pick section demands.
  const [pf, setPf] = useState({ from: '', to: '', frequency: '', unit: '', consolidated: 'no' });
  const [pApplied, setPApplied] = useState(pf);
  const { data: demandsData, loading: demandsLoading, reload: reloadDemands } = useFetch('/demands', pApplied);
  const demands = demandsData?.rows || [];
  const [picked, setPicked] = useState(() => new Set());

  // Step 2: the consolidated demand being prepared.
  const { data: nextNo, reload: reloadNo } = useFetch('/consolidated-demands/next-no');
  const [editing, setEditing] = useState(null);
  const [h, setH] = useState(() => blankHead(meta.today));
  const [sources, setSources] = useState([]); // section demands included
  const [lines, setLines] = useState([]);
  const [line, setLine] = useState(blankLine);
  const [busy, setBusy] = useState(false);
  const set = (k) => (v) => setH((s) => ({ ...s, [k]: v?.target ? v.target.value : v }));

  const { data: listData, loading: listLoading, reload: reloadList } = useFetch('/consolidated-demands');
  const saved = listData?.rows || [];
  const [viewing, setViewing] = useState(null);
  const [removing, setRemoving] = useState(null);

  const reset = () => {
    setEditing(null);
    setH(blankHead(meta.today));
    setSources([]);
    setLines([]);
    setLine(blankLine);
    setPicked(new Set());
  };
  const consolidatePicked = () => {
    const chosen = demands.filter((d) => picked.has(d._id));
    if (!chosen.length) return toast.error('Tick the section demands to consolidate');
    // Merge into what is already being prepared (items already there get the extra quantities).
    const merged = combine(chosen);
    setLines((ls) => {
      const out = ls.map((l) => ({ ...l, breakdown: [...(l.breakdown || [])] }));
      for (const m of merged) {
        const ex = out.find((l) => l.item === m.item);
        if (ex) {
          ex.qty = Math.round((Number(ex.qty) + m.qty) * 1000) / 1000;
          ex.breakdown.push(...m.breakdown);
        } else out.push(m);
      }
      return out;
    });
    setSources((s) => [...s, ...chosen.filter((d) => !s.some((x) => x._id === d._id)).map((d) => ({ _id: d._id, demandNo: d.demandNo, unit: d.unit }))]);
    setH((s) => ({ ...s, frequency: chosen[0].frequency || s.frequency }));
    setPicked(new Set());
    toast.success(`${chosen.length} demand(s) consolidated — review the quantities below`);
  };
  const addLine = () => {
    if (!line.item) return toast.error('Select an item');
    if (!(Number(line.qty) > 0)) return toast.error('Enter the quantity');
    if (lines.some((l) => l.item === line.item)) return toast.error('This item is already in the list — change its quantity instead');
    setLines((ls) => [...ls, { ...line, qty: Number(line.qty), rate: line.rate === '' ? '' : Number(line.rate), breakdown: [] }]);
    setLine(blankLine);
  };
  const save = async (print) => {
    if (!lines.length) return toast.error('Consolidate section demands or add items first');
    setBusy(true);
    try {
      const body = {
        ...h,
        sourceDemands: sources.map((s) => s._id),
        lines: lines.map((l) => ({ item: l.item, qty: Number(l.qty), rate: Number(l.rate || 0), remarks: l.remarks || '', breakdown: l.breakdown || [] })),
      };
      const { consolidated } = editing ? await api.put(`/consolidated-demands/${editing._id}`, body) : await api.post('/consolidated-demands', body);
      toast.success(`Consolidated demand ${consolidated.cdNo} ${editing ? 'updated' : 'saved'}`);
      reset();
      reloadNo();
      reloadList();
      reloadDemands();
      if (print) {
        setViewing(consolidated);
        setTimeout(() => printSection('cd-print'), 150);
      }
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  const edit = (cd) => {
    setEditing(cd);
    setH({
      date: String(cd.date).slice(0, 10),
      forwardedTo: cd.forwardedTo,
      subject: cd.subject,
      frequency: cd.frequency || 'Regular',
      codeHead: cd.codeHead || '',
      authority: cd.authority,
      remarks: cd.remarks,
    });
    setSources((cd.sourceDemands || []).map((s) => ({ _id: s._id, demandNo: s.demandNo, unit: s.unit })));
    setLines(cd.lines.map((l) => ({ item: l.item?._id || l.item, qty: l.qty, rate: l.rate || '', remarks: l.remarks, breakdown: l.breakdown || [] })));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const allTicked = demands.length > 0 && demands.every((d) => picked.has(d._id));

  return (
    <>
      {canWrite && (
        <Panel title="Step 1 – Pick Section Demands to Consolidate" icon={ClipboardList}>
          <form
            className="filters"
            onSubmit={(e) => {
              e.preventDefault();
              setPApplied(pf);
            }}
          >
            <Field label="From" stack>
              <input className="input" type="date" value={pf.from} onChange={(e) => setPf({ ...pf, from: e.target.value })} />
            </Field>
            <Field label="To" stack>
              <input className="input" type="date" value={pf.to} onChange={(e) => setPf({ ...pf, to: e.target.value })} />
            </Field>
            <Field label="Frequency" stack>
              <Select value={pf.frequency} onChange={(v) => setPf({ ...pf, frequency: v })} placeholder="All" options={frequencies} />
            </Field>
            <Field label="Unit" stack>
              <Select value={pf.unit} onChange={(v) => setPf({ ...pf, unit: v })} placeholder="All" options={settings.units} />
            </Field>
            <Field label="Show" stack>
              <Select
                value={pf.consolidated}
                onChange={(v) => setPf({ ...pf, consolidated: v })}
                options={[
                  { value: 'no', label: 'Not yet consolidated' },
                  { value: '', label: 'All demands' },
                ]}
              />
            </Field>
            <button className="btn btn-blue">
              <Search size={18} /> Show Demands
            </button>
          </form>
          <div className="table-wrap" style={{ marginTop: 10, maxHeight: 280 }}>
            <table className="data">
              <thead>
                <tr>
                  <th>
                    <input type="checkbox" checked={allTicked} onChange={() => setPicked(allTicked ? new Set() : new Set(demands.map((d) => d._id)))} aria-label="Tick all" />
                  </th>
                  <th>Demand No.</th>
                  <th>Date</th>
                  <th>Unit</th>
                  <th>Sub Section</th>
                  <th>Frequency</th>
                  <th>Items</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {demands.map((d) => (
                  <tr key={d._id} className={picked.has(d._id) ? 'row-picked' : undefined}>
                    <td className="center">
                      <input
                        type="checkbox"
                        checked={picked.has(d._id)}
                        disabled={sources.some((s) => s._id === d._id)}
                        onChange={() =>
                          setPicked((p) => {
                            const n = new Set(p);
                            n.has(d._id) ? n.delete(d._id) : n.add(d._id);
                            return n;
                          })
                        }
                      />
                    </td>
                    <td className="center">{d.demandNo}</td>
                    <td className="center">{fmtDate(d.date)}</td>
                    <td>{d.unit}</td>
                    <td>{d.subSection || '-'}</td>
                    <td className="center">{d.frequency || 'Regular'}</td>
                    <td className="center">{d.lines.length}</td>
                    <td className="center">
                      {sources.some((s) => s._id === d._id) ? (
                        <span className="badge badge-blue">Added</span>
                      ) : d.consolidatedIn?.no ? (
                        <span className="badge badge-grey">In {d.consolidatedIn.no}</span>
                      ) : (
                        <span className="badge badge-green">Open</span>
                      )}
                    </td>
                  </tr>
                ))}
                {!demands.length && (
                  <tr>
                    <td colSpan={8} className="empty">
                      {demandsLoading ? 'Loading…' : 'No section demands to consolidate.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
            <button type="button" className="btn btn-purple" onClick={consolidatePicked} disabled={!picked.size}>
              <Combine size={18} /> Consolidate Selected ({picked.size})
            </button>
          </div>
        </Panel>
      )}

      <Panel title={editing ? `Edit Consolidated Demand ${editing.cdNo}` : 'Step 2 – Consolidated Demand'} icon={Layers}>
        <div className="grid-2">
          <div className="form-col">
            <Field label="Consolidated Demand No.">
              <input className="input" readOnly value={editing ? editing.cdNo : nextNo?.next || ''} title="Assigned automatically when saved" />
            </Field>
            <Field label="Forwarded To">
              <input className="input" value={h.forwardedTo} onChange={set('forwardedTo')} maxLength={200} placeholder="e.g. Procurement Section / GE / Purchase Cell" />
            </Field>
            <Field label="Subject">
              <input className="input" value={h.subject} onChange={set('subject')} maxLength={300} placeholder="e.g. Consolidated demand of stores for Q3 2026-27" />
            </Field>
          </div>
          <div className="form-col">
            <Field label="Date" required>
              <input className="input" type="date" value={h.date} onChange={set('date')} />
            </Field>
            <Field label="Frequency">
              <Select value={h.frequency} onChange={set('frequency')} options={frequencies.includes(h.frequency) ? frequencies : [h.frequency, ...frequencies]} />
            </Field>
            <Field label="Authority">
              <input className="input" value={h.authority} onChange={set('authority')} maxLength={160} placeholder="Type the authority" />
            </Field>
            {/* Same list as the Orders page (Settings → Orders – Drop-down Lists → Code Heads). */}
            <Field label="Code Head">
              <Select value={h.codeHead} onChange={set('codeHead')} placeholder="— Select —" options={codeHeads.includes(h.codeHead) || !h.codeHead ? codeHeads : [h.codeHead, ...codeHeads]} />
            </Field>
          </div>
        </div>
        <div style={{ marginTop: 8 }}>
          <Field label="Remarks">
            <input className="input" value={h.remarks} onChange={set('remarks')} maxLength={500} />
          </Field>
        </div>
        {sources.length > 0 && (
          <div className="cd-sources">
            Section demands included:{' '}
            {sources.map((s) => (
              <span key={s._id} className="badge badge-blue">
                {s.demandNo} · {s.unit}
              </span>
            ))}
          </div>
        )}

        <h5 className="audit-h" style={{ marginTop: 12 }}>Items (any ledger)</h5>
        {canWrite && (
          <div className="filters" style={{ marginBottom: 10 }}>
            <div className="field stack grow">
              <label className="req">Add another item</label>
              <select className="input" value={line.item} onChange={(e) => setLine({ ...line, item: e.target.value })}>
                <option value="">Select Item</option>
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
              <input className="input" readOnly value={itemById.get(line.item)?.uom || ''} style={{ width: 80 }} />
            </Field>
            <Field label="Qty" required stack>
              <input className="input" type="number" min="0" step="any" value={line.qty} onChange={(e) => setLine({ ...line, qty: e.target.value })} style={{ width: 110 }} />
            </Field>
            <Field label="Rate (₹) – optional" stack>
              <input className="input" type="number" min="0" step="any" value={line.rate} onChange={(e) => setLine({ ...line, rate: e.target.value })} style={{ width: 120 }} />
            </Field>
            <button type="button" className="btn btn-green" onClick={addLine}>
              <Plus size={18} /> Add Item
            </button>
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
                <th>Demanded By (Section-wise)</th>
                <th className="num">Total Qty</th>
                <th className="num">Rate (₹)</th>
                <th>Remarks</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const it = itemById.get(l.item);
                const upd = (k, v) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
                return (
                  <tr key={l.item}>
                    <td className="center">{i + 1}</td>
                    <td>{it?.name || '…'}</td>
                    <td>{it ? ledgerLabel(it.ledger) : ''}</td>
                    <td className="center">{it?.uom}</td>
                    <td style={{ fontSize: 12.5 }}>{l.breakdown?.length ? shareText(l.breakdown) : <span className="muted">Added directly</span>}</td>
                    <td className="num">
                      <input className="input cd-qty" type="number" min="0" step="any" value={l.qty} onChange={(e) => upd('qty', e.target.value)} disabled={!canWrite} />
                    </td>
                    <td className="num">
                      <input className="input cd-qty" type="number" min="0" step="any" value={l.rate} onChange={(e) => upd('rate', e.target.value)} disabled={!canWrite} placeholder="—" />
                    </td>
                    <td>
                      <input className="input" value={l.remarks || ''} onChange={(e) => upd('remarks', e.target.value)} maxLength={200} disabled={!canWrite} />
                    </td>
                    <td className="center">
                      {canWrite && (
                        <button type="button" className="icon-btn del" title="Remove" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                          <Trash2 size={16} />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {!lines.length && (
                <tr>
                  <td colSpan={9} className="empty">
                    Tick section demands above and press Consolidate Selected, or add items directly.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {canWrite && (
          <div className="row" style={{ gap: 10, justifyContent: 'center', marginTop: 12 }}>
            <button type="button" className="btn btn-green btn-lg" disabled={busy} onClick={() => save(false)}>
              <Save size={18} /> {editing ? 'Save Changes' : 'Save Consolidated Demand'}
            </button>
            <button type="button" className="btn btn-blue btn-lg" disabled={busy} onClick={() => save(true)}>
              <Printer size={18} /> Save &amp; Print
            </button>
            <button type="button" className="btn btn-outline btn-lg" onClick={reset}>
              <RotateCcw size={18} /> {editing ? 'Cancel Edit' : 'Clear'}
            </button>
          </div>
        )}
      </Panel>

      <Panel title="Consolidated Demand Register" icon={Layers}>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Sl.</th>
                <th>CD No.</th>
                <th>Date</th>
                <th>Forwarded To</th>
                <th>Section Demands</th>
                <th>Items</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {saved.map((cd, i) => (
                <tr key={cd._id}>
                  <td className="center">{i + 1}</td>
                  <td className="center">{cd.cdNo}</td>
                  <td className="center">{fmtDate(cd.date)}</td>
                  <td>{cd.forwardedTo || '-'}</td>
                  <td>{(cd.sourceDemands || []).map((s) => s.demandNo).join(', ') || '-'}</td>
                  <td className="center">{cd.lines.length}</td>
                  <td className="center" style={{ whiteSpace: 'nowrap' }}>
                    <button type="button" className="icon-btn" title="View" onClick={() => setViewing(cd)}>
                      <Eye size={18} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      title="Print"
                      onClick={() => {
                        setViewing(cd);
                        setTimeout(() => printSection('cd-print'), 150);
                      }}
                    >
                      <Printer size={18} />
                    </button>
                    {canWrite && (
                      <button type="button" className="icon-btn edit" title="Edit" onClick={() => edit(cd)}>
                        <Pencil size={18} />
                      </button>
                    )}
                    {isAdmin && (
                      <button type="button" className="icon-btn del" title="Delete" onClick={() => setRemoving(cd)}>
                        <Trash2 size={18} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {!saved.length && (
                <tr>
                  <td colSpan={7} className="empty">
                    {listLoading ? 'Loading…' : 'No consolidated demands yet.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      {viewing && (
        <Modal
          printable
          title={`Consolidated Demand ${viewing.cdNo}`}
          size="lg"
          onClose={() => setViewing(null)}
          footer={
            <button type="button" className="btn btn-blue" onClick={() => printSection('cd-print')}>
              <Printer size={18} /> Print
            </button>
          }
        >
          <div className="audit-meta">
            <div>
              <span>Date</span> {fmtDate(viewing.date)}
            </div>
            <div>
              <span>Forwarded To</span> <b>{viewing.forwardedTo || '—'}</b>
            </div>
            <div className="wide">
              <span>Section demands</span> {(viewing.sourceDemands || []).map((s) => `${s.demandNo} (${s.unit})`).join(', ') || '—'}
            </div>
          </div>
          <table className="data" style={{ marginTop: 10 }}>
            <thead>
              <tr>
                <th>Sl.</th>
                <th>Item Name</th>
                <th>A/U</th>
                <th>Section-wise</th>
                <th className="num">Total Qty</th>
              </tr>
            </thead>
            <tbody>
              {viewing.lines.map((l, i) => (
                <tr key={i}>
                  <td className="center">{i + 1}</td>
                  <td>{l.item?.name}</td>
                  <td className="center">{l.item?.uom}</td>
                  <td style={{ fontSize: 12.5 }}>{l.breakdown?.length ? shareText(l.breakdown) : '—'}</td>
                  <td className="num">{fmtQty(l.qty)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <ConsolidatedPrint cd={viewing} />
        </Modal>
      )}
      {removing && (
        <Modal
          title={`Delete ${removing.cdNo}?`}
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
                    await api.del(`/consolidated-demands/${removing._id}`);
                    toast.success(`${removing.cdNo} deleted — its section demands are open again`);
                    setRemoving(null);
                    reloadList();
                    reloadDemands();
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
          The section demands in it become “not yet consolidated” again. Stock is not affected.
        </Modal>
      )}
    </>
  );
}
