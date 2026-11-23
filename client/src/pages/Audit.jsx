import { useRef, useState } from 'react';
import {
  ShieldCheck, Plus, Search, Eye, Printer, Pencil, Trash2, Paperclip, Upload, Send, FileText, FileSpreadsheet, Presentation,
  Image as ImageIcon, Download, X, CheckCircle2, RotateCcw,
} from 'lucide-react';
import { api } from '../api.js';
import { useApp } from '../context/AppContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { useFetch } from '../hooks.js';
import { Panel, Field, Select, Modal, StatusBadge, LedgerPrintHeader } from '../components/ui.jsx';
import { fmtDate } from '../utils/format.js';
import { printSection } from '../utils/export.js';

const DEFAULT_OFFICES = ['LAO', 'Test Audit', 'CAG', 'Internal Audit'];
const STATUSES = [
  { value: 'OPEN', label: 'Open' },
  { value: 'REPLIED', label: 'Replied' },
  { value: 'SETTLED', label: 'Settled' },
];
const ACCEPT = '.pdf,.doc,.docx,.xls,.xlsx,.csv,.ppt,.pptx,.jpg,.jpeg,.png,.gif,.webp';
const MAX_MB = 15;

const fileUrl = (f, download) => `/api/audits/files/${f.fileId}${download ? '?download' : ''}`;
const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
function FileIcon({ type, size = 18 }) {
  if (type.startsWith('image/')) return <ImageIcon size={size} />;
  if (type.includes('sheet') || type.includes('excel') || type === 'text/csv') return <FileSpreadsheet size={size} />;
  if (type.includes('presentation') || type.includes('powerpoint')) return <Presentation size={size} />;
  return <FileText size={size} />;
}

/** Read a browser File as base64 (without the "data:…;base64," prefix). */
const toBase64 = (file) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(new Error(`Could not read "${file.name}"`));
    r.readAsDataURL(file);
  });

/** Upload files one by one to an observation (or one of its replies). Returns the latest observation. */
async function uploadFiles(obsId, files, replyId) {
  let latest = null;
  for (const file of files) {
    if (file.size > MAX_MB * 1048576) throw new Error(`"${file.name}" is larger than ${MAX_MB} MB`);
    const data = await toBase64(file);
    latest = (await api.post(`/audits/${obsId}/files`, { name: file.name, data, ...(replyId && { replyId }) })).observation;
  }
  return latest;
}

/** Chosen (not yet uploaded) files, with remove buttons. */
function PickedFiles({ files, onRemove }) {
  if (!files.length) return null;
  return (
    <ul className="audit-files picked">
      {files.map((f, i) => (
        <li key={`${f.name}-${i}`}>
          <Paperclip size={15} /> {f.name} <span className="muted">({fmtSize(f.size)})</span>
          <button type="button" className="icon-btn del" title="Remove" onClick={() => onRemove(i)}>
            <X size={15} />
          </button>
        </li>
      ))}
    </ul>
  );
}

function FilePickerButton({ onPick, label = 'Import Files' }) {
  const ref = useRef(null);
  return (
    <>
      <input
        ref={ref}
        type="file"
        multiple
        accept={ACCEPT}
        hidden
        onChange={(e) => {
          onPick([...e.target.files]);
          e.target.value = '';
        }}
      />
      <button type="button" className="btn btn-outline" onClick={() => ref.current?.click()}>
        <Upload size={16} /> {label}
      </button>
    </>
  );
}

/** Attached files: PDFs and images open in a new tab; Word / Excel / PowerPoint download. */
function AttachedFiles({ files, canDelete, onDelete }) {
  if (!files?.length) return <span className="muted">No files attached.</span>;
  return (
    <ul className="audit-files">
      {files.map((f) => {
        const opens = f.type === 'application/pdf' || f.type.startsWith('image/');
        return (
          <li key={f.fileId}>
            {f.type.startsWith('image/') ? (
              <a href={fileUrl(f)} target="_blank" rel="noreferrer" className="audit-thumb no-print">
                <img src={fileUrl(f)} alt={f.name} loading="lazy" />
              </a>
            ) : (
              <FileIcon type={f.type} />
            )}
            <a href={fileUrl(f, !opens)} target={opens ? '_blank' : undefined} rel="noreferrer">
              {f.name}
            </a>
            <span className="muted">({fmtSize(f.size)})</span>
            <a className="icon-btn no-print" href={fileUrl(f, true)} title="Download">
              <Download size={15} />
            </a>
            {canDelete && (
              <button type="button" className="icon-btn del no-print" title="Remove file" onClick={() => onDelete(f)}>
                <Trash2 size={15} />
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** New / edit observation. */
function ObservationForm({ initial, offices, onClose, onSaved }) {
  const { meta, ledgerLabel } = useApp();
  const toast = useToast();
  const [f, setF] = useState(
    initial
      ? { ...initial, letterNo: initial.letterNo || '', letterDate: initial.letterDate ? String(initial.letterDate).slice(0, 10) : '' }
      : { office: offices[0] || '', team: '', auditPeriod: '', paraNo: '', letterNo: '', letterDate: '', date: meta.today, ledger: '', reference: '', subject: '', observation: '' },
  );
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const set = (k) => (v) => setF((s) => ({ ...s, [k]: v?.target ? v.target.value : v }));

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const fields = { office: f.office, team: f.team, auditPeriod: f.auditPeriod, paraNo: f.paraNo, letterNo: f.letterNo, letterDate: f.letterDate, date: String(f.date).slice(0, 10), ledger: f.ledger, reference: f.reference, subject: f.subject, observation: f.observation };
      let { observation } = initial ? await api.put(`/audits/${initial._id}`, fields) : await api.post('/audits', fields);
      if (files.length) observation = (await uploadFiles(observation._id, files)) || observation;
      toast.success(initial ? `Observation ${observation.obsNo} updated` : `Observation ${observation.obsNo} recorded`);
      onSaved(observation);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={initial ? `Edit Observation ${initial.obsNo}` : 'New Audit Observation'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="audit-form" className="btn btn-green" disabled={busy}>
            <CheckCircle2 size={18} /> {busy ? 'Saving…' : 'Save Observation'}
          </button>
        </>
      }
    >
      <form id="audit-form" onSubmit={save} className="grid-2">
        <Field label="Audit Office" required>
          <input className="input" list="audit-offices" value={f.office} onChange={set('office')} required maxLength={80} placeholder="LAO / Test Audit / CAG" />
          <datalist id="audit-offices">
            {offices.map((o) => (
              <option key={o} value={o} />
            ))}
          </datalist>
        </Field>
        <Field label="Observation Date" required>
          <input className="input" type="date" value={String(f.date).slice(0, 10)} onChange={set('date')} required />
        </Field>
        <Field label="Audit Office Letter No.">
          <input className="input" value={f.letterNo} onChange={set('letterNo')} maxLength={120} placeholder="Letter through which the observation was raised" />
        </Field>
        <Field label="Letter Date">
          <input className="input" type="date" value={f.letterDate} onChange={set('letterDate')} />
        </Field>
        <Field label="Audit Team / Officer">
          <input className="input" value={f.team} onChange={set('team')} maxLength={120} placeholder="e.g. AAO Sh. R K Das & team" />
        </Field>
        <Field label="Audit Period">
          <input className="input" value={f.auditPeriod} onChange={set('auditPeriod')} maxLength={80} placeholder="e.g. Apr 2025 – Mar 2026" />
        </Field>
        <Field label="Para / Obs. No.">
          <input className="input" value={f.paraNo} onChange={set('paraNo')} maxLength={40} placeholder="e.g. Para 3(a)" />
        </Field>
        <Field label="Ledger">
          <Select value={f.ledger} onChange={set('ledger')} placeholder="— Not specific —" options={meta.ledgers.map((l) => ({ value: l.key, label: ledgerLabel(l.key) }))} />
        </Field>
        <div style={{ gridColumn: '1 / -1', display: 'grid', gap: 10 }}>
          <Field label="Reference">
            <input className="input" value={f.reference} onChange={set('reference')} maxLength={200} placeholder="Voucher no. / item / ledger page referred to, e.g. R-000001, Paper A4 Pg 10" />
          </Field>
          <Field label="Subject" required>
            <input className="input" value={f.subject} onChange={set('subject')} required maxLength={200} placeholder="Short subject of the observation" />
          </Field>
          <Field label="Observation">
            <textarea className="input" rows={5} value={f.observation} onChange={set('observation')} maxLength={10000} placeholder="Observation as raised by the audit team" />
          </Field>
          <Field label="Audit Documents">
            <div style={{ display: 'grid', gap: 6 }}>
              <div className="row" style={{ gap: 8 }}>
                <FilePickerButton onPick={(picked) => setFiles((x) => [...x, ...picked])} />
                <span className="muted" style={{ fontSize: 12.5 }}>
                  Word, Excel, PowerPoint, PDF or image · up to {MAX_MB} MB each
                </span>
              </div>
              <PickedFiles files={files} onRemove={(i) => setFiles((x) => x.filter((_, j) => j !== i))} />
            </div>
          </Field>
        </div>
      </form>
    </Modal>
  );
}

/** One observation: details, audit documents, replies (with files), status, print. */
function ObservationView({ id, onClose, onChanged, onEdit }) {
  const { meta, ledgerLabel, canWrite, isAdmin, settings } = useApp();
  const toast = useToast();
  const { data, reload } = useFetch(`/audits/${id}`);
  const obs = data?.observation;
  const [reply, setReply] = useState({ date: meta.today, letterRef: '', text: '' });
  const [replyFiles, setReplyFiles] = useState([]);
  const [busy, setBusy] = useState(false);

  const refresh = () => {
    reload();
    onChanged();
  };
  const act = async (fn, msg) => {
    setBusy(true);
    try {
      await fn();
      if (msg) toast.success(msg);
      refresh();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  const sendReply = (e) => {
    e.preventDefault();
    if (!reply.text.trim() && !replyFiles.length) return toast.error('Type a reply or attach a file');
    act(async () => {
      const { replyId } = await api.post(`/audits/${id}/replies`, reply);
      if (replyFiles.length) await uploadFiles(id, replyFiles, replyId);
      setReply({ date: meta.today, letterRef: '', text: '' });
      setReplyFiles([]);
    }, 'Reply added');
  };
  const removeFile = (f) => {
    if (window.confirm?.(`Remove "${f.name}"?`) === false) return;
    act(() => api.del(`/audits/${id}/files/${f.fileId}`), 'File removed');
  };

  return (
    <Modal
      title={obs ? `Audit Observation ${obs.obsNo}` : 'Audit Observation'}
      onClose={onClose}
      size="lg"
      footer={
        obs && (
          <>
            {canWrite && obs.status !== 'SETTLED' && (
              <button type="button" className="btn btn-green" disabled={busy} onClick={() => act(() => api.patch(`/audits/${id}/status`, { status: 'SETTLED' }), 'Marked as settled')}>
                <CheckCircle2 size={18} /> Mark Settled
              </button>
            )}
            {canWrite && obs.status === 'SETTLED' && (
              <button type="button" className="btn btn-outline" disabled={busy} onClick={() => act(() => api.patch(`/audits/${id}/status`, { status: obs.replies.length ? 'REPLIED' : 'OPEN' }), 'Re-opened')}>
                <RotateCcw size={18} /> Re-open
              </button>
            )}
            {canWrite && (
              <button type="button" className="btn btn-outline" onClick={() => onEdit(obs)}>
                <Pencil size={18} /> Edit
              </button>
            )}
            <button type="button" className="btn btn-blue" onClick={() => printSection('audit-print')}>
              <Printer size={18} /> Print
            </button>
          </>
        )
      }
    >
      {!obs ? (
        'Loading…'
      ) : (
        <div id="audit-print" className="audit-view">
          <div className="print-doc">
            <div className="voucher-head">
              <h4 className="voucher-title">AUDIT OBSERVATION &amp; REPLY</h4>
              <div className="voucher-unit">UNIT:- {settings.orgTitle}</div>
            </div>
          </div>
          <div className="audit-meta">
            <div><span>Obs. No.</span> <b>{obs.obsNo}</b></div>
            <div><span>Status</span> <StatusBadge status={obs.status} />{obs.settledOn && <small className="muted"> on {fmtDate(obs.settledOn)}</small>}</div>
            <div><span>Audit Office</span> <b>{obs.office}</b></div>
            <div><span>Date</span> {fmtDate(obs.date)}</div>
            <div><span>Team / Officer</span> {obs.team || '—'}</div>
            <div><span>Audit Period</span> {obs.auditPeriod || '—'}</div>
            <div><span>Para / Obs. No.</span> {obs.paraNo || '—'}</div>
            <div><span>Audit Letter No.</span> <b>{obs.letterNo || '—'}</b></div>
            <div><span>Letter Date</span> {obs.letterDate ? fmtDate(obs.letterDate) : '—'}</div>
            <div><span>Ledger</span> {obs.ledger ? ledgerLabel(obs.ledger) : '—'}</div>
            <div className="wide"><span>Reference</span> {obs.reference || '—'}</div>
            <div className="wide"><span>Subject</span> <b>{obs.subject}</b></div>
          </div>
          <h5 className="audit-h">Observation</h5>
          <div className="audit-text">{obs.observation || <span className="muted">—</span>}</div>
          <h5 className="audit-h">
            Audit Documents
            {canWrite && (
              <span className="no-print" style={{ marginLeft: 'auto' }}>
                <FilePickerButton label="Add Files" onPick={(picked) => act(() => uploadFiles(id, picked), 'Files attached')} />
              </span>
            )}
          </h5>
          <AttachedFiles files={obs.files} canDelete={canWrite} onDelete={removeFile} />

          <h5 className="audit-h">Replies ({obs.replies.length})</h5>
          {obs.replies.length ? (
            <ol className="audit-replies">
              {obs.replies.map((r) => (
                <li key={r._id}>
                  <div className="audit-reply-head">
                    <b>{fmtDate(r.date)}</b>
                    {r.letterRef && (
                      <>
                        {' '}
                        · Our Letter Ref. <b>{r.letterRef}</b>
                      </>
                    )}{' '}
                    · {r.byName || 'Store'}
                    {canWrite && (
                      <button
                        type="button"
                        className="icon-btn del no-print"
                        title="Delete reply"
                        onClick={() => window.confirm?.('Delete this reply and its files?') !== false && act(() => api.del(`/audits/${id}/replies/${r._id}`), 'Reply deleted')}
                      >
                        <Trash2 size={15} />
                      </button>
                    )}
                  </div>
                  {r.text && <div className="audit-text">{r.text}</div>}
                  {r.files.length > 0 && <AttachedFiles files={r.files} canDelete={canWrite} onDelete={removeFile} />}
                </li>
              ))}
            </ol>
          ) : (
            <span className="muted">No reply yet.</span>
          )}

          {canWrite && (
            <form className="audit-reply-form no-print" onSubmit={sendReply}>
              <h5 className="audit-h">Add Reply</h5>
              <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
                <Field label="Reply Date" stack>
                  <input className="input" type="date" value={reply.date} onChange={(e) => setReply({ ...reply, date: e.target.value })} required />
                </Field>
                <Field label="Our Letter Ref. No." stack>
                  <input
                    className="input"
                    value={reply.letterRef}
                    onChange={(e) => setReply({ ...reply, letterRef: e.target.value })}
                    maxLength={120}
                    placeholder="e.g. MES/ST/2026/77"
                    style={{ width: 200 }}
                  />
                </Field>
                <div className="field stack grow">
                  <label>Reply</label>
                  <textarea className="input" rows={3} value={reply.text} onChange={(e) => setReply({ ...reply, text: e.target.value })} maxLength={10000} placeholder="Reply / action taken by the store" />
                </div>
              </div>
              <PickedFiles files={replyFiles} onRemove={(i) => setReplyFiles((x) => x.filter((_, j) => j !== i))} />
              <div className="row" style={{ gap: 8, marginTop: 8 }}>
                <FilePickerButton label="Attach Files" onPick={(picked) => setReplyFiles((x) => [...x, ...picked])} />
                <button className="btn btn-blue" disabled={busy}>
                  <Send size={16} /> {busy ? 'Saving…' : 'Add Reply'}
                </button>
                {isAdmin && (
                  <button
                    type="button"
                    className="btn btn-red"
                    style={{ marginLeft: 'auto' }}
                    onClick={() => window.confirm?.(`Delete observation ${obs.obsNo} with all its replies and files?`) !== false && api.del(`/audits/${id}`).then(() => { toast.success('Observation deleted'); onChanged(); onClose(); }, (e) => toast.error(e.message))}
                  >
                    <Trash2 size={16} /> Delete Observation
                  </button>
                )}
              </div>
            </form>
          )}
          <div className="print-doc">
            <div className="doc-sign">
              <div>Store Keeper</div>
              <div>Officer In-Charge</div>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** Reports → Audit: observations raised by audit teams (LAO, Test Audit, CAG …), with documents and replies. */
export default function AuditObservations() {
  const { settings, canWrite, ledgerLabel } = useApp();
  const offices = settings.auditOffices?.length ? settings.auditOffices : DEFAULT_OFFICES;
  const [f, setF] = useState({ office: '', status: '', q: '', from: '', to: '' });
  const [applied, setApplied] = useState(f);
  const { data, loading, reload } = useFetch('/audits', applied);
  const rows = data?.rows || [];
  const [editing, setEditing] = useState(null); // {} = new, observation = edit
  const [viewing, setViewing] = useState(null);
  const counts = STATUSES.map((s) => [s.label, rows.filter((r) => r.status === s.value).length]);

  return (
    <Panel
      title="Audit Observations (LAO / Test Audit / CAG …)"
      icon={ShieldCheck}
      id="audit-list-print"
      right={
        <span className="no-print row" style={{ gap: 8 }}>
          <button type="button" className="btn btn-outline" disabled={!rows.length} onClick={() => printSection('audit-list-print')}>
            <Printer size={16} /> Print List
          </button>
          {canWrite && (
            <button type="button" className="btn btn-green" onClick={() => setEditing({})}>
              <Plus size={16} /> New Observation
            </button>
          )}
        </span>
      }
    >
      <form
        className="filters no-print"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(f);
        }}
      >
        <Field label="Audit Office" stack>
          <Select value={f.office} onChange={(v) => setF({ ...f, office: v })} placeholder="All Offices" options={offices} />
        </Field>
        <Field label="Status" stack>
          <Select value={f.status} onChange={(v) => setF({ ...f, status: v })} placeholder="All" options={STATUSES} />
        </Field>
        <Field label="From" stack>
          <input className="input" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
        </Field>
        <Field label="To" stack>
          <input className="input" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
        </Field>
        <div className="field stack grow">
          <label>Search</label>
          <input className="input" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} placeholder="Subject, para no., letter no., reference, obs. no." />
        </div>
        <button className="btn btn-blue">
          <Search size={18} /> Search
        </button>
      </form>
      <div className="print-doc">
        <LedgerPrintHeader ledger="AUDIT OBSERVATIONS" asOn={fmtDate(new Date())} />
      </div>
      <div className="audit-counts no-print">
        {counts.map(([label, n]) => (
          <span key={label} className={`audit-count ${label.toLowerCase()}`}>
            {label}: <b>{n}</b>
          </span>
        ))}
      </div>
      <div className="table-wrap" style={{ marginTop: 10 }}>
        <table className="data">
          <thead>
            <tr>
              <th>Sl.</th>
              <th>Obs. No.</th>
              <th>Date</th>
              <th>Audit Office</th>
              <th>Para / Letter No.</th>
              <th>Subject</th>
              <th>Ledger / Reference</th>
              <th>Files</th>
              <th>Replies</th>
              <th>Status</th>
              <th className="no-print">Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r._id}>
                <td className="center">{i + 1}</td>
                <td className="center">{r.obsNo}</td>
                <td className="center">{fmtDate(r.date)}</td>
                <td className="center">{r.office}</td>
                <td className="center">
                  {r.paraNo || '-'}
                  {r.letterNo && <div className="item-desc">Ltr {r.letterNo}</div>}
                </td>
                <td>{r.subject}</td>
                <td>
                  {r.ledger ? ledgerLabel(r.ledger) : ''}
                  {r.reference && <div className="item-desc">{r.reference}</div>}
                </td>
                <td className="center">{r.files.length + r.replies.reduce((n, x) => n + x.files.length, 0)}</td>
                <td className="center">{r.replies.length}</td>
                <td className="center">
                  <StatusBadge status={r.status} />
                </td>
                <td className="center no-print" style={{ whiteSpace: 'nowrap' }}>
                  <button type="button" className="icon-btn" title="View / Reply" onClick={() => setViewing(r._id)}>
                    <Eye size={18} />
                  </button>
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={11} className="empty">
                  {loading ? 'Loading…' : 'No audit observations recorded.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {editing && (
        <ObservationForm
          initial={editing._id ? editing : null}
          offices={offices}
          onClose={() => setEditing(null)}
          onSaved={(obs) => {
            setEditing(null);
            reload();
            setViewing(obs._id);
          }}
        />
      )}
      {viewing && !editing && <ObservationView id={viewing} onClose={() => setViewing(null)} onChanged={reload} onEdit={(obs) => setEditing(obs)} />}
    </Panel>
  );
}
