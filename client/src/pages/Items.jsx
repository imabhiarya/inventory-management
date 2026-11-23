import { useState } from 'react';
import { Box, Plus, Pencil, Trash2, RotateCcw, List, Search, Info } from 'lucide-react';
import { api } from '../api.js';
import { useApp } from '../context/AppContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { useFetch } from '../hooks.js';
import { PageHeader, Panel, Field, Select, StatusBadge, ExportButtons, DocHeader, Modal } from '../components/ui.jsx';
import AddLedgerModal from '../components/AddLedgerModal.jsx';
import LedgerPicker from '../components/LedgerPicker.jsx';
import { fmtQty, fmtMoney } from '../utils/format.js';

const EMPTY = {
  name: '',
  description: '',
  ledgerPage: '',
  ledger: 'STATIONARY',
  uom: 'Nos',
  category: 'NON_CONSUMABLE',
  minStock: 0,
  status: 'ACTIVE',
};

const CATEGORIES = [
  { value: 'CONSUMABLE', label: 'Consumable' },
  { value: 'NON_CONSUMABLE', label: 'Non-Consumable' },
];
const categoryLabel = (v) => (v === 'CONSUMABLE' ? 'Consumable' : 'Non-Consumable');

export default function Items() {
  const { meta, settings, canWrite, isAdmin, ledgerLabel } = useApp();
  const toast = useToast();
  const [form, setForm] = useState(EMPTY);
  const [editing, setEditing] = useState(null); // item being edited
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(null);
  const [addLedger, setAddLedger] = useState(false);
  const [filters, setFilters] = useState({ ledger: '', status: '', q: '' });
  const [applied, setApplied] = useState(filters);
  const { data, loading, reload } = useFetch('/items', applied);
  const items = data?.items || [];

  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: typeof v === 'object' && v?.target ? v.target.value : v }));
  // Keep the last chosen Type of Store / Ledger, so several items for one ledger can be entered in a row.
  const reset = () => {
    setForm((f) => ({ ...EMPTY, ledger: editing ? EMPTY.ledger : f.ledger }));
    setEditing(null);
  };

  const payload = () => ({
    name: form.name,
    description: form.description,
    ledgerPage: form.ledgerPage,
    ledger: form.ledger,
    uom: form.uom,
    category: form.category,
    minStock: Number(form.minStock || 0),
    status: form.status,
  });

  const save = async (e) => {
    e?.preventDefault();
    setBusy(true);
    try {
      if (editing) {
        const { item } = await api.put(`/items/${editing._id}`, payload());
        toast.success(item.code !== editing.code ? `${editing.code} moved to ${ledgerLabel(item.ledger)} as ${item.code}` : `${item.code} updated`);
      } else {
        const { item } = await api.post('/items', payload());
        toast.success(`Registered ${item.code} – ${item.name} in ${ledgerLabel(item.ledger)}`);
      }
      reset();
      reload();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (it) => {
    setEditing(it);
    setForm({ ...EMPTY, ...it });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const doDelete = async () => {
    const it = confirmDel;
    setConfirmDel(null);
    try {
      await api.del(`/items/${it._id}`);
      toast.success(`${it.code} deleted`);
      if (editing?._id === it._id) reset();
      reload();
    } catch (err) {
      toast.error(err.message);
    }
  };

  const ledgerOpts = meta.ledgers.map((l) => ({ value: l.key, label: l.label }));
  const columns = [
    { key: 'sl', label: 'Sl.', value: (r) => items.indexOf(r) + 1 },
    { key: 'code', label: 'Item Code' },
    { key: 'name', label: 'Item Name', width: 30 },
    { key: 'description', label: 'Description / Specification', width: 34 },
    { key: 'ledgerPage', label: 'Ledger Page' },
    { key: 'ledger', label: 'Type of Store / Ledger', format: (v) => ledgerLabel(v), width: 22 },
    { key: 'uom', label: 'UoM' },
    { key: 'category', label: 'Category', format: categoryLabel },
    { key: 'minStock', label: 'Min Stock', align: 'right', numeric: true },
    { key: 'currentStock', label: 'Balance', align: 'right', numeric: true },
    { key: 'status', label: 'Status', format: (v) => (v === 'ACTIVE' ? 'Active' : 'Inactive') },
  ];

  return (
    <>
      <PageHeader icon={Box} plainIcon title="New Stock Entry (Item Master)" />

      {canWrite && (
        <Panel title={editing ? `Edit Item – ${editing.code}` : 'Add / Register New Item'} icon={Box}>
          <form onSubmit={save}>
            <div className="grid-2">
              <div style={{ display: 'grid', gap: 10 }}>
                <Field label="Item Code" required>
                  <input
                    className="input"
                    readOnly
                    value={editing ? editing.code : `AUTO (e.g. ${(meta.allLedgers || meta.ledgers).find((l) => l.key === form.ledger)?.prefix || 'ST'}-0001)`}
                  />
                </Field>
                <Field label="Item Name" required>
                  <input className="input" value={form.name} onChange={set('name')} placeholder="Enter Item Name (e.g. A4 Paper)" required maxLength={150} />
                </Field>
                <Field label="Item Description">
                  <textarea className="input" value={form.description} onChange={set('description')} placeholder="Enter Description / Specification" maxLength={500} />
                </Field>
                <Field label="Ledger Page">
                  <input className="input" value={form.ledgerPage} onChange={set('ledgerPage')} placeholder="Enter Ledger Page No. (auto-filled in Receipt & Issue)" maxLength={30} />
                </Field>
              </div>
              <div style={{ display: 'grid', gap: 10, alignContent: 'start' }}>
                <Field label="Type of Store / Ledger" required>
                  <div className="row" style={{ flexWrap: 'nowrap', gap: 6 }}>
                    <LedgerPicker
                      value={form.ledger}
                      onChange={set('ledger')}
                      title={editing ? 'Can be changed only while the item has not been used on any voucher; it then gets a new item code' : undefined}
                    />
                    {isAdmin && !editing && (
                      <button type="button" className="btn btn-green" title="Add a new Type of Store / Ledger" onClick={() => setAddLedger(true)} style={{ padding: '6px 10px' }}>
                        <Plus size={18} /> New
                      </button>
                    )}
                  </div>
                </Field>
                <Field label="UoM" required>
                  <Select value={form.uom} onChange={set('uom')} options={settings.uoms} />
                </Field>
                <Field label="Item Category" required>
                  <Select value={form.category} onChange={set('category')} options={CATEGORIES} />
                </Field>
                <Field label="Min Stock (Re-Order Level)">
                  <input className="input" type="number" min="0" step="any" value={form.minStock} onChange={set('minStock')} />
                </Field>
                <Field label="Status" required>
                  <Select
                    className="input highlight"
                    value={form.status}
                    onChange={set('status')}
                    options={[
                      { value: 'ACTIVE', label: 'Active' },
                      { value: 'INACTIVE', label: 'Inactive' },
                    ]}
                  />
                </Field>
              </div>
            </div>
            <div className="actions">
              <button className="btn btn-green btn-lg" disabled={busy || !!editing}>
                <Plus size={20} /> Add Item
              </button>
              <button type="button" className="btn btn-blue btn-lg" disabled={busy || !editing} onClick={save}>
                <Pencil size={20} /> Update Item
              </button>
              <button type="button" className="btn btn-red btn-lg" disabled={busy || !editing} onClick={() => setConfirmDel(editing)}>
                <Trash2 size={20} /> Delete Item
              </button>
              <button type="button" className="btn btn-outline btn-lg" onClick={reset}>
                <RotateCcw size={20} /> Clear / Reset
              </button>
            </div>
          </form>
        </Panel>
      )}

      <Panel title="Item Master List (Registered Items)" icon={List} id="item-list">
        <div className="no-print">
          <form
            className="filters"
            onSubmit={(e) => {
              e.preventDefault();
              setApplied(filters);
            }}
          >
            <Field label="Type of Store / Ledger" stack>
              <Select value={filters.ledger} onChange={(v) => setFilters({ ...filters, ledger: v })} placeholder="All Ledgers" options={ledgerOpts} />
            </Field>
            <div className="field stack grow">
              <label>Item Name</label>
              <input className="input" placeholder="Search item name / code…" value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} />
            </div>
            <Field label="Status" stack>
              <Select
                value={filters.status}
                onChange={(v) => setFilters({ ...filters, status: v })}
                placeholder="All"
                options={[
                  { value: 'ACTIVE', label: 'Active' },
                  { value: 'INACTIVE', label: 'Inactive' },
                ]}
              />
            </Field>
            <button className="btn btn-blue">
              <Search size={18} /> Search
            </button>
            <button
              type="button"
              className="btn btn-outline"
              onClick={() => {
                const blank = { ledger: '', status: '', q: '' };
                setFilters(blank);
                setApplied(blank);
                reload();
              }}
            >
              <RotateCcw size={18} /> Refresh
            </button>
          </form>
        </div>
        <div className="print-doc">
          <DocHeader title="Item Master List" />
        </div>
        <div className="table-wrap" style={{ marginTop: 12 }}>
          <table className="data">
            <thead>
              <tr>
                <th>Sl.</th>
                <th>Item Code</th>
                <th>Item Name</th>
                <th>Description / Specification</th>
                <th>Ledger Page</th>
                <th>Type of Store / Ledger</th>
                <th>UoM</th>
                <th>Category</th>
                <th className="num">Min Stock</th>
                <th className="num">Balance</th>
                <th className="num">Avg Rate (₹)</th>
                <th>Status</th>
                {canWrite && <th className="no-print">Action</th>}
              </tr>
            </thead>
            <tbody>
              {items.map((it, i) => (
                <tr key={it._id}>
                  <td className="center">{i + 1}</td>
                  <td className="center">{it.code}</td>
                  <td>{it.name}</td>
                  <td>{it.description}</td>
                  <td className="center">{it.ledgerPage}</td>
                  <td>{ledgerLabel(it.ledger)}</td>
                  <td className="center">{it.uom}</td>
                  <td className="center">{categoryLabel(it.category)}</td>
                  <td className="num">{fmtQty(it.minStock)}</td>
                  <td className={`num ${it.currentStock <= it.minStock && it.status === 'ACTIVE' ? 'error-text' : ''}`}>{fmtQty(it.currentStock)}</td>
                  <td className="num">{fmtMoney(it.avgRate)}</td>
                  <td className="center">
                    <StatusBadge status={it.status} />
                  </td>
                  {canWrite && (
                    <td className="center no-print" style={{ whiteSpace: 'nowrap' }}>
                      <button type="button" className="icon-btn edit" title="Edit" onClick={() => startEdit(it)}>
                        <Pencil size={18} />
                      </button>
                      <button type="button" className="icon-btn del" title="Delete" onClick={() => setConfirmDel(it)}>
                        <Trash2 size={18} />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
              {!items.length && (
                <tr>
                  <td colSpan={13} className="empty">
                    {loading ? 'Loading…' : 'No items found.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      <div className="row no-print" style={{ marginBottom: 8 }}>
        <div className="note" style={{ flex: 1 }}>
          <Info size={22} />
          <ul>
            <li>Items added here will be available in Receipt, Issue and Master Ledger.</li>
            <li>Ledger Page is filled in automatically as the Ledger Page No. when the item is selected in Receipt or Issue (it can still be changed there).</li>
            <li>Min Stock is used for Low Stock Alert and Re-Order.</li>
            <li>Only items never used on a receipt, issue or loan voucher can be deleted. Used items stay for their ledger history – set them to Inactive to stop further use.</li>
          </ul>
        </div>
        <ExportButtons
          printId="item-list"
          disabled={!items.length}
          getExport={() => ({ title: 'Item Master List', columns, rows: items, filename: 'item-master' })}
        />
      </div>

      {addLedger && (
        <AddLedgerModal onClose={() => setAddLedger(false)} onAdded={(l) => setForm((f) => ({ ...f, ledger: l.key }))} />
      )}

      {confirmDel && (
        <Modal
          title="Delete item?"
          size="sm"
          onClose={() => setConfirmDel(null)}
          footer={
            <>
              <button type="button" className="btn btn-ghost" onClick={() => setConfirmDel(null)}>
                Keep
              </button>
              <button type="button" className="btn btn-red" onClick={doDelete}>
                <Trash2 size={18} /> Delete
              </button>
            </>
          }
        >
          Delete <b>{confirmDel.code} – {confirmDel.name}</b>? This cannot be undone.
        </Modal>
      )}
    </>
  );
}
