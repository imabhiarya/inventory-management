import { useState } from 'react';
import { Settings as SettingsIcon, Store, ListChecks, Users, Save, Plus, Pencil, X, BookOpen, Trash2, Check, CornerDownRight, ListPlus, Hash, ShoppingCart, ClipboardPen } from 'lucide-react';
import AddLedgerModal from '../components/AddLedgerModal.jsx';
import { api } from '../api.js';
import { useApp } from '../context/AppContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { useFetch } from '../hooks.js';
import { PageHeader, Panel, Field, Select, Modal, StatusBadge } from '../components/ui.jsx';
import { fmtDate } from '../utils/format.js';

const LISTS = [
  ['units', 'Units / Sections (Issue To)'],
  ['sources', 'Sources (Receipt From)'],
  ['receiptTypes', 'Receipt Types'],
  ['issueTypes', 'Issue Types'],
  ['loanTypes', 'Loan Types'],
  ['otherOffices', 'Other Offices (Loan From Other Sources)'],
  ['storeTypes', 'Types of Store (Loan From Other Sources)'],
  ['uoms', 'Units of Measure (UoM)'],
  ['auditOffices', 'Audit Offices (LAO, Test Audit, CAG …)'],
  ['loanStoreTypes', 'Types of Loan Store (Loan Store Ledger)'],
];

// Orders page drop-downs, edited separately from the store lists above.
const ORDER_LISTS = [
  ['procurementModes', 'Modes of Procurement'],
  ['orderDemandFrom', 'Demand From (Units / Sections)'],
  ['orderApprovers', 'Approving Authorities (Approved By)'],
  ['orderCodeHeads', 'Code Heads (Orders)'],
  ['orderUoms', 'Units of Measure (Orders)'],
  ['orderProjectOffices', 'Offices (for Project contingency code head)'],
  ['orderAccountsOffices', 'Accounts Offices (Bill forwarded to)'],
];

// Demand page drop-downs.
const DEMAND_LISTS = [
  ['demandSubSections', 'Sub Sections'],
  ['demandFrequencies', 'Demand Frequencies'],
];

function ListEditor({ label, values = [], onChange, readOnly }) {
  const [text, setText] = useState('');
  const add = () => {
    const v = text.trim();
    if (v && !values.includes(v)) onChange([...values, v]);
    setText('');
  };
  return (
    <div className="panel" style={{ marginBottom: 0 }}>
      <div className="panel-head light" style={{ fontSize: 15 }}>{label}</div>
      <div className="panel-body">
        <div className="row" style={{ gap: 6 }}>
          {values.map((v) => (
            <span key={v} className="badge badge-blue" style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
              {v}
              {!readOnly && (
                <button type="button" className="icon-btn" style={{ padding: 0 }} aria-label={`Remove ${v}`} onClick={() => onChange(values.filter((x) => x !== v))}>
                  <X size={12} />
                </button>
              )}
            </span>
          ))}
        </div>
        {!readOnly && (
          <div className="row" style={{ marginTop: 8, flexWrap: 'nowrap' }}>
            <input
              className="input"
              value={text}
              maxLength={120}
              placeholder="Add new…"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  add();
                }
              }}
            />
            <button type="button" className="btn btn-ghost" onClick={add}>
              <Plus size={16} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function LedgersPanel() {
  const { meta, isAdmin, reloadMeta } = useApp();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [addingUnder, setAddingUnder] = useState(null); // group ledger a sub-ledger is being added to
  // Top-level ledgers, each followed by its sub-ledgers (e.g. Maint Store → B&R / E&M Store Ledger).
  const allLedgers = meta.allLedgers || meta.ledgers;
  const isGroup = (key) => allLedgers.some((x) => x.parent === key);
  const ledgerRows = allLedgers.filter((l) => !l.parent).flatMap((l) => [l, ...allLedgers.filter((c) => c.parent === l.key)]);
  const [renaming, setRenaming] = useState(null); // { key, label }
  const [removing, setRemoving] = useState(null);

  const run = async (fn, msg) => {
    try {
      await fn();
      await reloadMeta();
      toast.success(msg);
      return true;
    } catch (e) {
      toast.error(e.message);
      return false;
    }
  };

  return (
    <Panel
      title="Types of Store / Ledgers"
      icon={BookOpen}
      bodyClass="table-wrap"
      right={
        isAdmin && (
          <button type="button" className="btn btn-green" onClick={() => setAdding(true)}>
            <Plus size={16} /> Add Ledger
          </button>
        )
      }
    >
      <table className="data">
        <thead>
          <tr>
            <th>Sl.</th>
            <th>Ledger Name</th>
            <th>Item Code Prefix</th>
            <th>Example Code</th>
            {isAdmin && <th>Action</th>}
          </tr>
        </thead>
        <tbody>
          {ledgerRows.map((l, i) => (
            <tr key={l.key} className={l.parent ? 'subledger-row' : isGroup(l.key) ? 'group-row' : undefined}>
              <td className="center">{i + 1}</td>
              <td>
                {renaming?.key === l.key ? (
                  <form
                    className="row"
                    style={{ flexWrap: 'nowrap', gap: 6 }}
                    onSubmit={async (e) => {
                      e.preventDefault();
                      if (await run(() => api.patch(`/settings/ledgers/${l.key}`, { label: renaming.label }), 'Ledger renamed')) setRenaming(null);
                    }}
                  >
                    <input className="inline-input" value={renaming.label} maxLength={60} autoFocus onChange={(e) => setRenaming({ ...renaming, label: e.target.value })} />
                    <button className="icon-btn edit" title="Save" aria-label="Save name">
                      <Check size={18} />
                    </button>
                    <button type="button" className="icon-btn" title="Cancel" aria-label="Cancel rename" onClick={() => setRenaming(null)}>
                      <X size={18} />
                    </button>
                  </form>
                ) : l.parent ? (
                  <span className="subledger-name">
                    <CornerDownRight size={16} /> {l.label}
                  </span>
                ) : (
                  <>
                    {l.label}
                    {isGroup(l.key) && <span className="group-badge">Group – {allLedgers.filter((c) => c.parent === l.key).length} sub-ledgers</span>}
                  </>
                )}
              </td>
              <td className="center">
                <b>{l.prefix}</b>
              </td>
              <td className="center">{l.prefix}-0001</td>
              {isAdmin && (
                <td className="center" style={{ whiteSpace: 'nowrap' }}>
                  <button type="button" className="icon-btn edit" title="Rename" onClick={() => setRenaming({ key: l.key, label: l.label })}>
                    <Pencil size={18} />
                  </button>
                  {!l.parent && l.key !== 'LOAN' && (
                    <button type="button" className="icon-btn edit" title="Add a sub-ledger under this ledger" onClick={() => setAddingUnder(l)}>
                      <ListPlus size={18} />
                    </button>
                  )}
                  {l.key !== 'LOAN' && !isGroup(l.key) && (
                    <button type="button" className="icon-btn del" title="Remove" onClick={() => setRemoving(l)}>
                      <Trash2 size={18} />
                    </button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted" style={{ margin: '10px 4px 0', fontSize: 13 }}>
        A ledger can only be removed while no items are registered in it. The Loan Store Ledger is required by the Loan Store module. Use{' '}
        <ListPlus size={14} style={{ verticalAlign: -2 }} /> to divide a ledger into sub-ledgers (for example Maint Store → B&amp;R / E&amp;M Store Ledger); items and
        vouchers then go into a sub-ledger, and every report lists each sub-ledger.
      </p>
      {adding && <AddLedgerModal onClose={() => setAdding(false)} />}
      {addingUnder && <AddLedgerModal parent={addingUnder} onClose={() => setAddingUnder(null)} />}
      {removing && (
        <Modal
          title="Remove ledger?"
          size="sm"
          onClose={() => setRemoving(null)}
          footer={
            <>
              <button type="button" className="btn btn-ghost" onClick={() => setRemoving(null)}>
                Keep
              </button>
              <button
                type="button"
                className="btn btn-red"
                onClick={async () => {
                  const l = removing;
                  setRemoving(null);
                  await run(() => api.del(`/settings/ledgers/${l.key}`), `${l.label} removed`);
                }}
              >
                <Trash2 size={18} /> Remove
              </button>
            </>
          }
        >
          Remove <b>{removing.label}</b> from the list of ledgers?
        </Modal>
      )}
    </Panel>
  );
}

/** Stock Indent numbering: issues from Maint Store sub-ledgers (B&R / E&M) are numbered e.g. SI-000001. */
function StockIndentPanel() {
  const { isAdmin } = useApp();
  const toast = useToast();
  const { data, reload } = useFetch('/settings/stock-indent');
  const [form, setForm] = useState(null); // { prefix, nextNo } while editing
  const [busy, setBusy] = useState(false);
  const shown = form || data;
  const preview = shown ? `${(shown.prefix || '').toUpperCase()}${String(shown.nextNo || 1).padStart(6, '0')}` : '';

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.put('/settings/stock-indent', { prefix: form.prefix, nextNo: Number(form.nextNo) });
      toast.success('Stock Indent numbering updated');
      setForm(null);
      reload();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Stock Indent Numbering (Maint Store)" icon={Hash}>
      {!shown ? (
        <span className="muted">Loading…</span>
      ) : (
        <form className="filters" onSubmit={save}>
          <Field label="Prefix" stack>
            <input
              className="input"
              value={shown.prefix}
              disabled={!isAdmin}
              maxLength={12}
              style={{ width: 150, textTransform: 'uppercase' }}
              onChange={(e) => setForm({ ...shown, prefix: e.target.value })}
            />
          </Field>
          <Field label="Next Number" stack>
            <input
              className="input"
              type="number"
              min={(data?.lastUsed || 0) + 1}
              value={shown.nextNo}
              disabled={!isAdmin}
              style={{ width: 130 }}
              onChange={(e) => setForm({ ...shown, nextNo: e.target.value })}
            />
          </Field>
          <div className="note" style={{ alignSelf: 'end' }}>
            Next Stock Indent No.: <b>{preview}</b>
            {data?.lastUsed ? <> · last used: {data.prefix}{String(data.lastUsed).padStart(6, '0')}</> : null}
          </div>
          {isAdmin && form && (
            <>
              <button className="btn btn-green" disabled={busy}>
                <Save size={16} /> Save
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setForm(null)}>
                <X size={16} /> Cancel
              </button>
            </>
          )}
        </form>
      )}
      <p className="muted" style={{ margin: '10px 4px 0', fontSize: 13 }}>
        Issues from the Maint Store sub-ledgers (B&amp;R / E&amp;M Store Ledger) are Stock Indents and get these numbers automatically. The next number
        cannot be set at or below one already used.
      </p>
    </Panel>
  );
}

function UserModal({ user, onClose, onSaved }) {
  const toast = useToast();
  const [f, setF] = useState(user ? { ...user, password: '' } : { username: '', name: '', designation: '', role: 'storekeeper', password: '', active: true });
  const [busy, setBusy] = useState(false);
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (user) {
        const body = { name: f.name, designation: f.designation, role: f.role, active: f.active };
        if (f.password) body.password = f.password;
        await api.patch(`/users/${user.id}`, body);
      } else {
        await api.post('/users', { username: f.username, name: f.name, designation: f.designation, role: f.role, password: f.password });
      }
      toast.success(user ? 'User updated' : 'User created');
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={user ? `Edit user ${user.username}` : 'New user'} onClose={onClose} size="sm">
      <form onSubmit={save} style={{ display: 'grid', gap: 10 }}>
        {!user && (
          <Field label="Username" required stack>
            <input className="input" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} required pattern="[a-zA-Z0-9._\-]{3,32}" autoComplete="off" />
          </Field>
        )}
        <Field label="Full name" required stack>
          <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={100} />
        </Field>
        <Field label="Rank / Appointment" stack>
          <input className="input" value={f.designation} onChange={(e) => setF({ ...f, designation: e.target.value })} maxLength={100} />
        </Field>
        <Field label="Role" required stack>
          <Select
            value={f.role}
            onChange={(v) => setF({ ...f, role: v })}
            options={[
              { value: 'admin', label: 'Admin – everything incl. users, settings, backup' },
              { value: 'storekeeper', label: 'Store Keeper – items, receipts, issues, loans' },
              { value: 'viewer', label: 'Viewer – read-only, reports' },
            ]}
          />
        </Field>
        {user && (
          <label className="row">
            <input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Account active
          </label>
        )}
        <Field label={user ? 'Reset password (leave blank to keep)' : 'Password'} required={!user} stack>
          <input className="input" type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required={!user} minLength={8} autoComplete="new-password" />
        </Field>
        <span className="muted">Passwords need 8+ characters with letters and numbers.</span>
        <button className="btn btn-blue" disabled={busy}>
          <Save size={18} /> Save
        </button>
      </form>
    </Modal>
  );
}

function UsersPanel() {
  const { user: me } = useApp();
  const { data, reload } = useFetch('/users');
  const [edit, setEdit] = useState(null);
  return (
    <Panel
      title="User Accounts"
      icon={Users}
      bodyClass="table-wrap"
      right={
        <button type="button" className="btn btn-green" onClick={() => setEdit({})}>
          <Plus size={16} /> New user
        </button>
      }
    >
      <table className="data">
        <thead>
          <tr>
            <th>Username</th>
            <th>Name</th>
            <th>Rank / Appointment</th>
            <th>Role</th>
            <th>Status</th>
            <th>Last sign-in</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {(data?.users || []).map((u) => (
            <tr key={u.id}>
              <td>
                {u.username}
                {u.id === me.id && <span className="muted"> (you)</span>}
              </td>
              <td>{u.name}</td>
              <td>{u.designation}</td>
              <td style={{ textTransform: 'capitalize' }}>{u.role}</td>
              <td className="center">
                <StatusBadge status={u.active ? 'ACTIVE' : 'INACTIVE'} />
              </td>
              <td className="center">{u.lastLoginAt ? fmtDate(u.lastLoginAt) : '—'}</td>
              <td className="center">
                <button type="button" className="icon-btn edit" title="Edit" onClick={() => setEdit(u)}>
                  <Pencil size={18} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {edit && <UserModal user={edit.id ? edit : null} onClose={() => setEdit(null)} onSaved={reload} />}
    </Panel>
  );
}

export default function SettingsPage() {
  const { settings, isAdmin, reloadMeta } = useApp();
  const toast = useToast();
  const [s, setS] = useState(() => ({ ...settings, otherOffices: settings.otherOffices || [], storeTypes: settings.storeTypes || [], codeHeads: settings.codeHeads.map((c) => ({ ...c })) }));
  const [busy, setBusy] = useState(false);
  const ro = !isAdmin;

  const save = async () => {
    setBusy(true);
    try {
      const body = {
        orgTitle: s.orgTitle,
        orgSubtitle: s.orgSubtitle,
        storeName: s.storeName,
        station: s.station,
        storeInCharge: s.storeInCharge,
        codeHeads: s.codeHeads.filter((c) => c.code.trim()),
      };
      for (const [k] of [...LISTS, ...ORDER_LISTS, ...DEMAND_LISTS]) body[k] = s[k];
      await api.put('/settings', body);
      await reloadMeta();
      toast.success('Settings saved');
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  const t = (k) => ({ value: s[k] || '', onChange: (e) => setS({ ...s, [k]: e.target.value }), readOnly: ro, className: 'input' });

  return (
    <>
      <PageHeader
        icon={SettingsIcon}
        plainIcon
        title="Settings"
        extra={
          isAdmin && (
            <button type="button" className="btn btn-blue btn-lg" onClick={save} disabled={busy}>
              <Save size={20} /> Save Settings
            </button>
          )
        }
      />
      {ro && <p className="note">Only an administrator can change settings.</p>}
      <Panel title="Organisation & Store Details" icon={Store}>
        <div className="grid-2">
          <Field label="Header Title" required>
            <input {...t('orgTitle')} maxLength={80} />
          </Field>
          <Field label="Header Subtitle">
            <input {...t('orgSubtitle')} maxLength={120} />
          </Field>
          <Field label="Store Name" required>
            <input {...t('storeName')} maxLength={120} />
          </Field>
          <Field label="Station / Unit">
            <input {...t('station')} maxLength={120} />
          </Field>
          <Field label="Store In-Charge">
            <input {...t('storeInCharge')} maxLength={120} />
          </Field>
        </div>
      </Panel>

      <LedgersPanel />
      <StockIndentPanel />

      <Panel title="Master Lists (used in drop-downs)" icon={ListChecks}>
        <div className="grid-2" style={{ gap: 14 }}>
          {LISTS.map(([k, label]) => (
            <ListEditor key={k} label={label} values={s[k] || []} readOnly={ro} onChange={(v) => setS({ ...s, [k]: v })} />
          ))}
          <div className="panel" style={{ marginBottom: 0 }}>
            <div className="panel-head light" style={{ fontSize: 15 }}>Code Heads</div>
            <div className="panel-body" style={{ display: 'grid', gap: 6 }}>
              {s.codeHeads.map((c, i) => (
                <div key={i} className="row" style={{ flexWrap: 'nowrap' }}>
                  <input className="input" style={{ width: 100 }} value={c.code} readOnly={ro} placeholder="Code" onChange={(e) => setS({ ...s, codeHeads: s.codeHeads.map((x, j) => (j === i ? { ...x, code: e.target.value } : x)) })} />
                  <input className="input" value={c.name} readOnly={ro} placeholder="Description" onChange={(e) => setS({ ...s, codeHeads: s.codeHeads.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
                  {!ro && (
                    <button type="button" className="icon-btn del" aria-label="Remove code head" onClick={() => setS({ ...s, codeHeads: s.codeHeads.filter((_, j) => j !== i) })}>
                      <X size={16} />
                    </button>
                  )}
                </div>
              ))}
              {!ro && (
                <button type="button" className="btn btn-ghost" onClick={() => setS({ ...s, codeHeads: [...s.codeHeads, { code: '', name: '' }] })}>
                  <Plus size={16} /> Add code head
                </button>
              )}
            </div>
          </div>
        </div>
      </Panel>

      <Panel title="Orders – Drop-down Lists" icon={ShoppingCart}>
        <p className="muted" style={{ margin: '0 2px 10px', fontSize: 13 }}>
          Used only on the Orders page; changing them does not affect Receipt, Issue or other pages. Press <b>Save Settings</b> (top) after editing.
        </p>
        <div className="grid-2" style={{ gap: 14 }}>
          {ORDER_LISTS.map(([k, label]) => (
            <ListEditor key={k} label={label} values={s[k] || []} readOnly={ro} onChange={(v) => setS({ ...s, [k]: v })} />
          ))}
        </div>
      </Panel>

      <Panel title="Demand – Drop-down Lists" icon={ClipboardPen}>
        <p className="muted" style={{ margin: '0 2px 10px', fontSize: 13 }}>
          Used on the Demand page (Unit comes from Units / Sections above). Press <b>Save Settings</b> (top) after editing.
        </p>
        <div className="grid-2" style={{ gap: 14 }}>
          {DEMAND_LISTS.map(([k, label]) => (
            <ListEditor key={k} label={label} values={s[k] || []} readOnly={ro} onChange={(v) => setS({ ...s, [k]: v })} />
          ))}
        </div>
      </Panel>

      {isAdmin && <UsersPanel />}
    </>
  );
}
