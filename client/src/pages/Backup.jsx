import { useRef, useState } from 'react';
import { Database, Download, Upload, AlertTriangle, FileSpreadsheet } from 'lucide-react';
import { api } from '../api.js';
import { useApp } from '../context/AppContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { PageHeader, Panel, Modal } from '../components/ui.jsx';
import { fmtDate } from '../utils/format.js';
import { download } from '../utils/export.js';
import { backupToExcel, excelToBackup } from '../utils/backupExcel.js';

export default function Backup() {
  const { reloadMeta } = useApp();
  const toast = useToast();
  const fileRef = useRef(null);
  const [pending, setPending] = useState(null); // parsed backup awaiting confirmation
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);

  const downloadExcel = async () => {
    setExporting(true);
    try {
      const backup = await api.get('/backup');
      const buf = await backupToExcel(backup);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      download(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `mes-store-backup-${stamp}.xlsx`);
    } catch (err) {
      toast.error(`Excel backup failed: ${err.message}`);
    } finally {
      setExporting(false);
    }
  };

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const json = /\.xlsx$/i.test(file.name) ? await excelToBackup(await file.arrayBuffer()) : JSON.parse(await file.text());
      if (json.format !== 'mes-store-backup') throw new Error('This file is not an MES Store backup');
      setPending({ name: file.name, json });
      setConfirmText('');
    } catch (err) {
      toast.error(err instanceof SyntaxError ? 'The file is not valid JSON' : err.message);
    }
  };

  const restore = async () => {
    setBusy(true);
    try {
      const res = await api.post('/backup/restore', pending.json);
      setPending(null);
      await reloadMeta();
      toast.success(`Restore complete: ${res.counts.items ?? 0} items, ${res.counts.stockTxns ?? 0} ledger entries`);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const counts = pending
    ? [
        ...Object.entries(pending.json.data || {}).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0]),
        ...(Array.isArray(pending.json.files) ? [['attachments', pending.json.files.length]] : []),
      ]
    : [];

  return (
    <>
      <PageHeader icon={Database} plainIcon title="Backup & Restore" />
      <div className="grid-2" style={{ alignItems: 'start' }}>
        <Panel title="Backup" icon={Download}>
          <p>Download a complete copy of the database (items, vouchers, ledgers, settings, audit attachments and users) as a JSON or Excel file.</p>
          <p className="muted">Store backups somewhere safe and off this computer (a pen drive or another PC). The file contains password hashes for user accounts.</p>
          <a className="btn btn-blue btn-lg" href="/api/backup" download>
            <Download size={20} /> Download Backup (JSON)
          </a>
          <button type="button" className="btn btn-green btn-lg" style={{ marginLeft: 10 }} disabled={exporting} onClick={downloadExcel}>
            <FileSpreadsheet size={20} /> {exporting ? 'Preparing Excel…' : 'Download Backup (Excel)'}
          </button>
          <p className="muted" style={{ marginTop: 10 }}>
            The Excel file has one sheet per register (items, receipts, issues, ledgers …) to view in Excel, and can be restored below just like
            the JSON file. Keep its sheet names and header rows unchanged.
          </p>
          <div className="note" style={{ marginTop: 14 }}>
            <div>
              <b>If this computer fails:</b> install the software on the new computer. On its first start, under
              <b> Moving from an old computer?</b> click <b>Choose backup file…</b> and pick this file. All data and user accounts come back, with the same
              usernames and passwords. No internet is needed.
            </div>
          </div>
        </Panel>
        <Panel title="Restore" icon={Upload}>
          <div className="note" style={{ background: 'var(--red-100)', borderColor: '#f3b4ae', marginBottom: 12 }}>
            <AlertTriangle size={22} color="var(--red-600)" />
            <div>
              Restoring <b>replaces all current data</b> with the contents of the backup file. Take a fresh backup first.
            </div>
          </div>
          <input ref={fileRef} type="file" accept="application/json,.json,.xlsx" hidden onChange={onFile} />
          <button type="button" className="btn btn-outline btn-lg" onClick={() => fileRef.current?.click()}>
            <Upload size={20} /> Choose backup file…
          </button>
          <p className="muted" style={{ marginTop: 8 }}>Accepts the JSON or the Excel (.xlsx) backup from this software.</p>
        </Panel>
      </div>

      {pending && (
        <Modal
          title="Confirm restore"
          size="sm"
          onClose={() => setPending(null)}
          footer={
            <>
              <button type="button" className="btn btn-ghost" onClick={() => setPending(null)}>
                Cancel
              </button>
              <button type="button" className="btn btn-red" disabled={busy || confirmText !== 'RESTORE'} onClick={restore}>
                {busy ? 'Restoring…' : 'Replace all data'}
              </button>
            </>
          }
        >
          <p style={{ marginTop: 0 }}>
            <b>{pending.name}</b>
            <br />
            Created {fmtDate(pending.json.createdAt)} by {pending.json.createdBy || 'unknown'}
          </p>
          <table className="data" style={{ marginBottom: 12 }}>
            <tbody>
              {counts.map(([k, n]) => (
                <tr key={k}>
                  <td>{k}</td>
                  <td className="num">{n}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <label>
            Type <b>RESTORE</b> to confirm:
            <input className="input" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} style={{ marginTop: 6 }} />
          </label>
        </Modal>
      )}
    </>
  );
}
