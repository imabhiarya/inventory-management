import { useMemo, useRef, useState } from 'react';
import { FileSpreadsheet as SheetIcon, ClipboardList, Plus, Trash2, Save, RotateCcw, Printer, Pencil, Eye, Search, X, Paperclip, Upload, Download } from 'lucide-react';
import { api } from '../api.js';
import { useApp } from '../context/AppContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { useFetch, useItems } from '../hooks.js';
import { Panel, Field, Modal, OrientationSelect, usePrintOrientation } from '../components/ui.jsx';
import { fmtDate, fmtQty, fmtMoney, numberToWords } from '../utils/format.js';
import { printSection } from '../utils/export.js';

const ACCEPT = '.pdf,.doc,.docx,.xls,.xlsx,.csv,.ppt,.pptx,.jpg,.jpeg,.png,.gif,.webp';
const MAX_MB = 15;
const fileUrl = (f, download) => `/api/dcs/files/${f.fileId}${download ? '?download' : ''}`;
const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const lineAmount = (l) => round2((Number(l.qty) || 0) * (Number(l.rate) || 0));
const blankLine = (nameOfWork = '') => ({ nameOfWork, item: '', description: '', uom: '', qty: '', rate: '', remarks: '' });
const blankHead = (today, unit = '') => ({ date: today, unit, jobNo: '', jobDescription: '', nameOfWork: '', authority: '', remarks: '' });

/** "Rupees One Lakh Twenty Thousand and Fifty Paise Only" */
function rupeesInWords(amount) {
  const rupees = Math.floor(amount);
  const paise = Math.round((amount - rupees) * 100);
  return `Rupees ${numberToWords(rupees)}${paise ? ` and ${numberToWords(paise)} Paise` : ''} Only`;
}

/** Read a browser File as base64 (without the "data:…;base64," prefix). */
const toBase64 = (file) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(new Error(`Could not read "${file.name}"`));
    r.readAsDataURL(file);
  });

async function uploadFiles(dcsId, files) {
  let latest = null;
  for (const file of files) {
    if (file.size > MAX_MB * 1048576) throw new Error(`"${file.name}" is larger than ${MAX_MB} MB`);
    latest = (await api.post(`/dcs/${dcsId}/files`, { name: file.name, data: await toBase64(file) })).dcs;
  }
  return latest;
}

/** The printed DCS (print only): header boxes, items, total in words and the signature blocks from Settings. */
export function DcsPrint({ dcs }) {
  const { settings } = useApp();
  return (
    <div className="print-doc dcs-print" id="dcs-print">
      <h3 className="dcs-title">{settings.dcsTitle || 'DRAFTED COSTED SCHEDULED'}</h3>
      {/* Details without borders: only the items table below has a grid. */}
      <div className="dcs-details">
        <div className="dcs-detail-row">
          <div>
            <span className="dcs-label">Unit</span>: {dcs.unit || settings.orgTitle}
          </div>
          <div className="dcs-date">
            <span className="dcs-label">Date</span>: {fmtDate(dcs.date)}
          </div>
        </div>
        <div>
          <span className="dcs-label">Job No.</span>: {dcs.jobNo || '—'}
        </div>
        <div>
          <span className="dcs-label">Job Description</span>: {dcs.jobDescription || '—'}
        </div>
        <div>
          <span className="dcs-label">Name of Work</span>: {dcs.nameOfWork || '—'}
        </div>
        <div>
          <span className="dcs-label">Authority</span>: {dcs.authority || '—'}
        </div>
      </div>
      <table className="data" style={{ marginTop: 10 }}>
        <thead>
          <tr>
            <th>Ser No.</th>
            <th>Name of Work</th>
            <th>Description of Item</th>
            <th>A/U</th>
            <th className="num">Qty</th>
            <th className="num">Rate (₹)</th>
            <th className="num">Total Amt (₹)</th>
            <th>Remarks</th>
          </tr>
        </thead>
        <tbody>
          {dcs.lines.map((l, i) => (
            <tr key={i}>
              <td className="center">{i + 1}</td>
              <td>{l.nameOfWork}</td>
              <td style={{ whiteSpace: 'pre-wrap' }}>{l.description}</td>
              <td className="center">{l.uom}</td>
              <td className="num">{fmtQty(l.qty)}</td>
              <td className="num">{fmtMoney(l.rate)}</td>
              <td className="num">{fmtMoney(l.amount)}</td>
              <td>{l.remarks}</td>
            </tr>
          ))}
          <tr className="voucher-count">
            <td colSpan={6} className="num">
              Grand Total (₹)
            </td>
            <td className="num">{fmtMoney(dcs.totalAmount)}</td>
            <td />
          </tr>
          <tr className="voucher-count">
            <td colSpan={8}>({rupeesInWords(dcs.totalAmount)})</td>
          </tr>
        </tbody>
      </table>
      {dcs.remarks && (
        <p>
          <b>Remarks:</b> {dcs.remarks}
        </p>
      )}
      {dcs.files?.length > 0 && (
        <p>
          <b>Encl:</b> Rate quotation(s) / documents – {dcs.files.map((f) => f.name).join('; ')}
        </p>
      )}
      <SignatureBlocks />
    </div>
  );
}

/**
 * The signature blocks set in Settings → DCS – Print Heading & Signature Blocks. Printed on the DCS and the
 * Consolidated Demand; nothing is printed when the list is empty.
 */
export function SignatureBlocks() {
  const { settings } = useApp();
  const signatures = settings.dcsSignatures || [];
  if (!signatures.length) return null;
  const width = `${Math.floor(96 / Math.min(signatures.length, 4))}%`;
  return (
    <div className="doc-sign sig-blocks">
      {signatures.map((s, i) => (
        <div key={i} style={{ width }}>
          <span className="sig-space" />
          <b>{s.title}</b>
          {s.name && <span>{s.name}</span>}
          {s.designation && <small>{s.designation}</small>}
        </div>
      ))}
    </div>
  );
}

/** Attached quotations: open / download, and remove when allowed. */
function FileList({ files, onRemove }) {
  if (!files?.length) return null;
  return (
    <ul className="audit-files">
      {files.map((f) => (
        <li key={f.fileId}>
          <Paperclip size={15} />
          <a href={fileUrl(f)} target="_blank" rel="noreferrer">
            {f.name}
          </a>
          <span className="muted">({fmtSize(f.size)})</span>
          <a className="icon-btn" href={fileUrl(f, true)} title="Download">
            <Download size={15} />
          </a>
          {onRemove && (
            <button type="button" className="icon-btn del" title="Remove" onClick={() => onRemove(f)}>
              <X size={15} />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * Description of Item: type to search the Item Master of every ledger (code, name, description) and pick
 * one, or type freely. After picking, the text stays editable — add size, make, specification and so on.
 */
function ItemDescription({ line, items, readOnly, onChange, onPick }) {
  const { ledgerLabel } = useApp();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const q = line.description.trim().toLowerCase();
  // Suggest while searching: not once an item is picked (then the text is the user's to extend).
  const matches = useMemo(() => {
    if (!open || line.item || q.length < 1) return [];
    const words = q.split(/\s+/);
    return items.filter((it) => words.every((w) => `${it.code} ${it.name} ${it.description || ''}`.toLowerCase().includes(w))).slice(0, 12);
  }, [open, line.item, q, items]);
  const pick = (it) => {
    onPick(it);
    setOpen(false);
  };
  return (
    <div className="dcs-desc">
      <textarea
        className="input"
        rows={line.description.includes('\n') || line.description.length > 40 ? 2 : 1}
        value={line.description}
        maxLength={1000}
        readOnly={readOnly}
        placeholder={readOnly ? '' : 'Type to search items of all ledgers, or type a description'}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (!matches.length) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, matches.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            pick(matches[active]);
          } else if (e.key === 'Escape') {
            setOpen(false);
          }
        }}
      />
      {line.item && !readOnly && <small className="dcs-desc-hint">From Item Master – you can add more description</small>}
      {matches.length > 0 && (
        <ul className="dcs-suggest" role="listbox">
          {matches.map((it, k) => (
            <li
              key={it._id}
              role="option"
              aria-selected={k === active}
              className={k === active ? 'active' : undefined}
              onMouseDown={(e) => {
                e.preventDefault(); // keep focus in the textarea
                pick(it);
              }}
              onMouseEnter={() => setActive(k)}
            >
              <b>{it.name}</b> <span className="muted">({it.code})</span>
              {it.description && <div className="muted">{it.description}</div>}
              <div className="dcs-suggest-meta">
                {ledgerLabel(it.ledger)} · {it.uom}
                {it.avgRate ? ` · ₹ ${fmtMoney(it.avgRate)}` : ''}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DcsForm({ editing, onSaved, onCancel, orientation, setOrientation }) {
  const { meta, settings, canWrite } = useApp();
  const toast = useToast();
  const { data: itemsData } = useItems(); // all ledgers
  const items = useMemo(() => itemsData?.items || [], [itemsData]);
  const { data: nextNo } = useFetch('/dcs/next-no');
  const fileRef = useRef(null);
  const [h, setH] = useState(() =>
    editing
      ? {
          date: String(editing.date).slice(0, 10),
          unit: editing.unit,
          jobNo: editing.jobNo,
          jobDescription: editing.jobDescription,
          nameOfWork: editing.nameOfWork,
          authority: editing.authority,
          remarks: editing.remarks,
        }
      : blankHead(meta.today, settings.orgTitle),
  );
  const [lines, setLines] = useState(() => (editing ? editing.lines.map((l) => ({ ...l, item: l.item || '' })) : [blankLine()]));
  const [files, setFiles] = useState(() => editing?.files || []); // already attached
  const [picked, setPicked] = useState([]); // chosen, uploaded on save
  const [busy, setBusy] = useState(false);
  const ro = !canWrite;

  const setHead = (k) => (e) => setH({ ...h, [k]: e.target.value });
  const setLine = (i, k) => (e) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, [k]: e.target.value } : l)));
  const total = round2(lines.reduce((s, l) => s + lineAmount(l), 0));

  const reset = () => {
    setH(blankHead(meta.today, settings.orgTitle));
    setLines([blankLine()]);
    setFiles([]);
    setPicked([]);
  };

  const save = async (print) => {
    const used = lines.filter((l) => l.description.trim() || l.qty || l.rate);
    if (!used.length) return toast.error('Add at least one item (Description of Item)');
    const missing = used.findIndex((l) => !l.description.trim());
    if (missing >= 0) return toast.error(`Ser No. ${missing + 1}: enter the Description of Item`);
    setBusy(true);
    try {
      const body = { ...h, lines: used.map(({ amount, item, ...l }) => ({ ...l, ...(item && { item: String(item) }), qty: Number(l.qty) || 0, rate: Number(l.rate) || 0 })) };
      let dcs = editing ? (await api.put(`/dcs/${editing._id}`, body)).dcs : (await api.post('/dcs', body)).dcs;
      if (picked.length) {
        try {
          dcs = (await uploadFiles(dcs._id, picked)) || dcs;
        } catch (e) {
          toast.error(`DCS saved, but a file could not be attached: ${e.message}`);
        }
      }
      toast.success(`${dcs.dcsNo} saved`);
      if (!editing) reset();
      onSaved(dcs, print);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  const removeAttached = async (f) => {
    try {
      const d = (await api.del(`/dcs/${editing._id}/files/${f.fileId}`)).dcs;
      setFiles(d.files);
      toast.success(`"${f.name}" removed`);
    } catch (e) {
      toast.error(e.message);
    }
  };

  return (
    <Panel title={editing ? `Edit ${editing.dcsNo}` : `New DCS${nextNo?.next ? ` – ${nextNo.next}` : ''}`} icon={SheetIcon}>
      <div className="dcs-head grid-2">
        <Field label="Unit" stack>
          <input className="input" list="dcs-units" value={h.unit} onChange={setHead('unit')} maxLength={160} readOnly={ro} placeholder="Type or pick" />
          <datalist id="dcs-units">
            {(settings.units || []).map((u) => (
              <option key={u} value={u} />
            ))}
          </datalist>
        </Field>
        <Field label="Date (any date – back date allowed)" stack>
          <input className="input" type="date" value={h.date} onChange={setHead('date')} readOnly={ro} />
        </Field>
        <Field label="Job No." stack>
          <input className="input" value={h.jobNo} onChange={setHead('jobNo')} maxLength={80} readOnly={ro} />
        </Field>
        <Field label="Authority" stack>
          <input className="input" list="dcs-authorities" value={h.authority} onChange={setHead('authority')} maxLength={300} readOnly={ro} placeholder="Type or pick" />
          <datalist id="dcs-authorities">
            {(settings.demandAuthorities || []).map((a) => (
              <option key={a} value={a} />
            ))}
          </datalist>
        </Field>
        <Field label="Job Description" stack>
          <textarea className="input" rows={2} value={h.jobDescription} onChange={setHead('jobDescription')} maxLength={1000} readOnly={ro} />
        </Field>
        <Field label="Name of Work" stack>
          <textarea className="input" rows={2} value={h.nameOfWork} onChange={setHead('nameOfWork')} maxLength={500} readOnly={ro} />
        </Field>
      </div>

      <div className="table-wrap" style={{ marginTop: 12 }}>
        <table className="data dcs-lines">
          <thead>
            <tr>
              <th style={{ width: 54 }}>Ser No.</th>
              <th>Name of Work</th>
              <th>Description of Item</th>
              <th style={{ width: 90 }}>A/U</th>
              <th className="num" style={{ width: 100 }}>
                Qty
              </th>
              <th className="num" style={{ width: 120 }}>
                Rate (₹)
              </th>
              <th className="num" style={{ width: 130 }}>
                Total Amt (₹)
              </th>
              <th>Remarks</th>
              {!ro && <th style={{ width: 40 }} />}
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td className="center">{i + 1}</td>
                <td>
                  <textarea className="input" rows={1} value={l.nameOfWork} onChange={setLine(i, 'nameOfWork')} maxLength={500} readOnly={ro} />
                </td>
                <td>
                  <ItemDescription
                    line={l}
                    items={items}
                    readOnly={ro}
                    onChange={(description) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, description, ...(!description.trim() && { item: '' }) } : x)))}
                    onPick={(it) =>
                      setLines((ls) =>
                        ls.map((x, j) =>
                          j === i
                            ? {
                                ...x,
                                item: it._id,
                                description: it.description ? `${it.name} – ${it.description}` : it.name,
                                uom: x.uom || it.uom,
                                rate: x.rate || (it.avgRate ? String(round2(it.avgRate)) : ''),
                              }
                            : x,
                        ),
                      )
                    }
                  />
                </td>
                <td>
                  <input className="input" list="dcs-uoms" value={l.uom} onChange={setLine(i, 'uom')} maxLength={30} readOnly={ro} />
                </td>
                <td>
                  <input className="input num" type="number" min="0" step="any" value={l.qty} onChange={setLine(i, 'qty')} readOnly={ro} />
                </td>
                <td>
                  <input className="input num" type="number" min="0" step="any" value={l.rate} onChange={setLine(i, 'rate')} readOnly={ro} />
                </td>
                <td className="num">
                  <b>{fmtMoney(lineAmount(l))}</b>
                </td>
                <td>
                  <input className="input" value={l.remarks} onChange={setLine(i, 'remarks')} maxLength={300} readOnly={ro} />
                </td>
                {!ro && (
                  <td className="center">
                    <button type="button" className="icon-btn del" title="Remove row" disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                      <Trash2 size={16} />
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th colSpan={6} className="num">
                Grand Total (₹)
              </th>
              <th className="num">{fmtMoney(total)}</th>
              <th colSpan={ro ? 1 : 2} />
            </tr>
          </tfoot>
        </table>
        <datalist id="dcs-uoms">
          {(settings.orderUoms?.length ? settings.orderUoms : settings.uoms || []).map((u) => (
            <option key={u} value={u} />
          ))}
        </datalist>
      </div>
      {!ro && (
        <div className="row" style={{ marginTop: 8, justifyContent: 'space-between' }}>
          <button type="button" className="btn btn-green" onClick={() => setLines((ls) => [...ls, blankLine(h.nameOfWork)])}>
            <Plus size={18} /> Add Row
          </button>
          <span className="muted">{total > 0 && rupeesInWords(total)}</span>
        </div>
      )}

      <Field label="Remarks" stack>
        <input className="input" value={h.remarks} onChange={setHead('remarks')} maxLength={1000} readOnly={ro} />
      </Field>

      <div className="dcs-attach">
        <div className="dcs-attach-head">
          <Paperclip size={18} /> <b>Rate Quotations / Documents</b>
          <span className="muted"> – PDF, Word, Excel or photos, up to {MAX_MB} MB each</span>
        </div>
        <FileList files={files} onRemove={!ro && editing ? removeAttached : null} />
        {picked.length > 0 && (
          <ul className="audit-files picked">
            {picked.map((f, i) => (
              <li key={`${f.name}-${i}`}>
                <Paperclip size={15} /> {f.name} <span className="muted">({fmtSize(f.size)}) – attached when you save</span>
                <button type="button" className="icon-btn del" title="Remove" onClick={() => setPicked((p) => p.filter((_, j) => j !== i))}>
                  <X size={15} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {!ro && (
          <>
            <input
              ref={fileRef}
              type="file"
              multiple
              accept={ACCEPT}
              hidden
              onChange={(e) => {
                const chosen = [...(e.target.files || [])];
                e.target.value = '';
                const big = chosen.find((f) => f.size > MAX_MB * 1048576);
                if (big) toast.error(`"${big.name}" is larger than ${MAX_MB} MB`);
                setPicked((p) => [...p, ...chosen.filter((f) => f.size <= MAX_MB * 1048576)]);
              }}
            />
            <button type="button" className="btn btn-outline" onClick={() => fileRef.current?.click()}>
              <Upload size={18} /> Attach Rate Quotation / Document
            </button>
          </>
        )}
      </div>

      {canWrite && (
        <div className="row" style={{ gap: 10, justifyContent: 'center', marginTop: 14 }}>
          <button type="button" className="btn btn-green btn-lg" disabled={busy} onClick={() => save(false)}>
            <Save size={18} /> {busy ? 'Saving…' : editing ? 'Save Changes' : 'Save DCS'}
          </button>
          <button type="button" className="btn btn-blue btn-lg" disabled={busy} onClick={() => save(true)}>
            <Printer size={18} /> Save &amp; Print
          </button>
          <OrientationSelect value={orientation} onChange={setOrientation} />
          <button type="button" className="btn btn-outline btn-lg" onClick={() => (editing ? onCancel() : reset())}>
            <RotateCcw size={18} /> {editing ? 'Cancel Edit' : 'Clear'}
          </button>
        </div>
      )}
    </Panel>
  );
}

/** DCS tab of the Demand page: entry form, register, print with signature blocks, and rate quotations. */
export default function DcsPage() {
  const { canWrite, isAdmin } = useApp();
  const toast = useToast();
  const [f, setF] = useState({ from: '', to: '', q: '' });
  const [applied, setApplied] = useState(f);
  const { data, loading, reload } = useFetch('/dcs', applied);
  const rows = data?.rows || [];
  const [editing, setEditing] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [removing, setRemoving] = useState(null);

  const [orientation, setOrientation] = usePrintOrientation(); // Portrait / Landscape, remembered
  const print = () => printSection('dcs-print', { orientation });
  const printDcs = (d) => {
    setViewing(d);
    setTimeout(print, 150);
  };

  return (
    <>
      <DcsForm
        key={editing?._id || 'new'}
        editing={editing}
        orientation={orientation}
        setOrientation={setOrientation}
        onCancel={() => setEditing(null)}
        onSaved={(d, andPrint) => {
          setEditing(null);
          reload();
          if (andPrint) printDcs(d);
        }}
      />

      <Panel title="DCS Register" icon={ClipboardList} right={<OrientationSelect value={orientation} onChange={setOrientation} />}>
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
          <div className="field stack grow">
            <label>Search</label>
            <input className="input" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} placeholder="DCS no., job no., name of work, unit, item" />
          </div>
          <button className="btn btn-blue">
            <Search size={18} /> Search
          </button>
        </form>
        <div className="table-wrap" style={{ marginTop: 10 }}>
          <table className="data">
            <thead>
              <tr>
                <th>Sl.</th>
                <th>DCS No.</th>
                <th>Date</th>
                <th>Unit</th>
                <th>Job No.</th>
                <th>Name of Work</th>
                <th className="num">Items</th>
                <th className="num">Total Amt (₹)</th>
                <th className="center">Quotations</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d, i) => (
                <tr key={d._id}>
                  <td className="center">{i + 1}</td>
                  <td className="center">{d.dcsNo}</td>
                  <td className="center">{fmtDate(d.date)}</td>
                  <td>{d.unit || '-'}</td>
                  <td>{d.jobNo || '-'}</td>
                  <td>{d.nameOfWork || '-'}</td>
                  <td className="num">{d.lines.length}</td>
                  <td className="num">{fmtMoney(d.totalAmount)}</td>
                  <td className="center">{d.files?.length || '-'}</td>
                  <td className="center" style={{ whiteSpace: 'nowrap' }}>
                    <button type="button" className="icon-btn" title="View" onClick={() => setViewing(d)}>
                      <Eye size={18} />
                    </button>
                    <button type="button" className="icon-btn" title="Print" onClick={() => printDcs(d)}>
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
                    {loading ? 'Loading…' : 'No DCS recorded.'}
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
          title={`${viewing.dcsNo} – ${fmtDate(viewing.date)}`}
          size="lg"
          onClose={() => setViewing(null)}
          footer={
            <>
              <OrientationSelect value={orientation} onChange={setOrientation} />
              <button type="button" className="btn btn-blue" onClick={print}>
                <Printer size={18} /> Print
              </button>
            </>
          }
        >
          <div className="audit-meta">
            <div>
              <span>Unit</span> <b>{viewing.unit || '—'}</b>
            </div>
            <div>
              <span>Job No.</span> {viewing.jobNo || '—'}
            </div>
            <div className="wide">
              <span>Job Description</span> {viewing.jobDescription || '—'}
            </div>
            <div className="wide">
              <span>Name of Work</span> {viewing.nameOfWork || '—'}
            </div>
            <div className="wide">
              <span>Authority</span> {viewing.authority || '—'}
            </div>
          </div>
          <table className="data" style={{ marginTop: 10 }}>
            <thead>
              <tr>
                <th>Ser No.</th>
                <th>Name of Work</th>
                <th>Description of Item</th>
                <th>A/U</th>
                <th className="num">Qty</th>
                <th className="num">Rate (₹)</th>
                <th className="num">Total Amt (₹)</th>
                <th>Remarks</th>
              </tr>
            </thead>
            <tbody>
              {viewing.lines.map((l, i) => (
                <tr key={i}>
                  <td className="center">{i + 1}</td>
                  <td>{l.nameOfWork}</td>
                  <td style={{ whiteSpace: 'pre-wrap' }}>{l.description}</td>
                  <td className="center">{l.uom}</td>
                  <td className="num">{fmtQty(l.qty)}</td>
                  <td className="num">{fmtMoney(l.rate)}</td>
                  <td className="num">{fmtMoney(l.amount)}</td>
                  <td>{l.remarks}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th colSpan={6} className="num">
                  Grand Total (₹)
                </th>
                <th className="num">{fmtMoney(viewing.totalAmount)}</th>
                <th />
              </tr>
            </tfoot>
          </table>
          {viewing.files?.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <b>Rate Quotations / Documents</b>
              <FileList files={viewing.files} />
            </div>
          )}
          <DcsPrint dcs={viewing} />
        </Modal>
      )}

      {removing && (
        <Modal
          title={`Delete ${removing.dcsNo}?`}
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
                    await api.del(`/dcs/${removing._id}`);
                    toast.success(`${removing.dcsNo} deleted`);
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
          This removes the DCS and its attached quotations for good.
        </Modal>
      )}
    </>
  );
}
