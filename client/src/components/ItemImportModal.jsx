import { useState } from 'react';
import { FileUp, FileDown, FileSpreadsheet, CheckCircle2, AlertTriangle } from 'lucide-react';
import { api } from '../api.js';
import { useApp } from '../context/AppContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { Modal } from './ui.jsx';
import { readItemFile, downloadItemsExcel } from '../utils/itemImport.js';

const ACTION = { create: ['New', 'green'], update: ['Update', 'blue'], same: ['No change', 'grey'], error: ['Skipped', 'red'] };

/**
 * Import ledger items from Excel / CSV / text / Word (preview first, then save) and export items to Excel.
 * Rows without a Ledger column go into `ledger` (the ledger open in Master Ledger). Existing items are
 * matched by Item Code, else by name + description in the same ledger, and updated — never duplicated.
 */
export default function ItemImportModal({ ledger, onClose }) {
  const { ledgerLabel, canWrite } = useApp();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [parsed, setParsed] = useState(null); // { name, items, plan }
  const [result, setResult] = useState(null);

  const pick = async (file) => {
    if (!file) return;
    setBusy(true);
    setResult(null);
    try {
      const items = await readItemFile(file);
      if (!items.length) throw new Error('No items found in the file. It needs an "Item Name" column (or a plain list of names).');
      const { plan } = await api.post('/items/import', { ledger, items, dryRun: true });
      setParsed({ name: file.name, items, plan });
    } catch (e) {
      toast.error(e.message);
      setParsed(null);
    } finally {
      setBusy(false);
    }
  };
  const doImport = async () => {
    setBusy(true);
    try {
      const { plan } = await api.post('/items/import', { ledger, items: parsed.items });
      const n = (a) => plan.filter((p) => p.action === a).length;
      setResult({ plan, created: n('create'), updated: n('update'), errors: n('error') });
      setParsed(null);
      toast.success(`Imported: ${n('create')} new, ${n('update')} updated${n('error') ? `, ${n('error')} skipped` : ''}`);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  const exportItems = async (all) => {
    setBusy(true);
    try {
      const { items } = await api.get('/items', all ? {} : { ledger });
      if (!items.length) return toast.error('No items to export');
      const tag = all ? 'all-ledgers' : ledger.toLowerCase();
      await downloadItemsExcel(items, `items-${tag}-${new Date().toISOString().slice(0, 10)}.xlsx`, ledgerLabel);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  const plan = parsed?.plan || result?.plan;
  const willSave = parsed?.plan.filter((p) => p.action === 'create' || p.action === 'update').length || 0;

  return (
    <Modal title="Import / Export Items" onClose={() => onClose(!!result)} size="lg">
      <div className="order-import">
        {canWrite && (
          <div className="order-import-box">
            <FileUp size={28} />
            <div>
              <b>Import items into {ledgerLabel(ledger)}</b>
              <div className="muted" style={{ fontSize: 13 }}>
                Excel (.xlsx), CSV, text (.txt) or Word (.docx table). Columns like <i>Item Name, Description, UoM / A/U, Ledger Page, Category, Min Stock</i> are
                recognised automatically; a file with a <i>Ledger</i> column puts each item in that ledger. Existing items (same Item Code, or same name + description in
                the ledger) are <b>updated, never duplicated</b>. Stock is not changed — bring balances in with a B/F receipt.
              </div>
            </div>
            <label className="btn btn-blue" style={{ cursor: busy ? 'progress' : 'pointer' }}>
              <FileSpreadsheet size={16} /> {busy ? 'Reading…' : 'Choose File'}
              <input type="file" hidden accept=".xlsx,.csv,.txt,.tsv,.docx" disabled={busy} onChange={(e) => (pick(e.target.files[0]), (e.target.value = ''))} />
            </label>
          </div>
        )}

        {plan && (
          <>
            <h5 className="audit-h">{parsed ? `Preview – ${parsed.name}` : 'Import result'}</h5>
            {result && (
              <div className="order-totals">
                <span>New: <b>{result.created}</b></span>
                <span>Updated: <b>{result.updated}</b></span>
                {result.errors > 0 && <span className="pending">Skipped: <b>{result.errors}</b></span>}
              </div>
            )}
            <div className="table-wrap" style={{ maxHeight: 340 }}>
              <table className="data">
                <thead>
                  <tr>
                    <th>Sl.</th>
                    <th>Item Code</th>
                    <th>Item Name</th>
                    <th>Ledger</th>
                    <th>UoM</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.map((p, i) => (
                    <tr key={i}>
                      <td className="center">{i + 1}</td>
                      <td>{p.code || (p.action === 'create' && parsed ? <span className="muted">new</span> : '-')}</td>
                      <td>
                        {p.name || '-'}
                        {parsed?.items[p.index]?.description && <div className="muted" style={{ fontSize: 12.5 }}>{parsed.items[p.index].description}</div>}
                      </td>
                      <td>{p.ledger ? ledgerLabel(p.ledger) : '-'}</td>
                      <td>{p.uom || parsed?.items[p.index]?.uom || '-'}</td>
                      <td>
                        <span className={`badge badge-${ACTION[p.action][1]}`}>{ACTION[p.action][0]}</span>
                        {p.error && <div className="error-text" style={{ fontSize: 12.5 }}>{p.error}</div>}
                        {p.note && <div className="muted" style={{ fontSize: 12.5 }}>{p.note}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {parsed && (
              <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
                <button type="button" className="btn btn-ghost" onClick={() => setParsed(null)}>
                  Cancel
                </button>
                <button type="button" className="btn btn-green" disabled={busy || !willSave} onClick={doImport}>
                  <CheckCircle2 size={16} /> Import {willSave} Item(s)
                </button>
              </div>
            )}
            {parsed?.plan.some((p) => p.action === 'error') && (
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                <AlertTriangle size={14} style={{ verticalAlign: -2 }} /> Skipped rows are not imported; fix them in the file and import again.
              </p>
            )}
          </>
        )}

        <h5 className="audit-h">Export</h5>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-green" disabled={busy} onClick={() => exportItems(false)}>
            <FileDown size={16} /> Export {ledgerLabel(ledger)} Items (Excel)
          </button>
          <button type="button" className="btn btn-blue" disabled={busy} onClick={() => exportItems(true)}>
            <FileDown size={16} /> Export All Ledgers (Excel)
          </button>
          <button type="button" className="btn btn-outline" disabled={busy} onClick={() => downloadItemsExcel([], 'item-import-template.xlsx')}>
            <FileSpreadsheet size={16} /> Download Import Template
          </button>
        </div>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          The export uses the same columns as the import template, so it can be edited in Excel and imported back — items are updated by their Item Code, not duplicated.
        </p>
      </div>
    </Modal>
  );
}
