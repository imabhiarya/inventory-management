import { useState } from 'react';
import { Plus } from 'lucide-react';
import { api } from '../api.js';
import { useApp } from '../context/AppContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { Field, Modal } from './ui.jsx';

/** Suggest a 2-letter code prefix from a name, skipping prefixes already in use. */
function suggestPrefix(name, used) {
  const letters = name.toUpperCase().replace(/LEDGER/g, '').replace(/[^A-Z]/g, '');
  if (letters.length < 2) return '';
  const candidates = [letters.slice(0, 2), letters[0] + letters[letters.length - 1], letters.slice(0, 3)];
  for (let i = 1; i < letters.length; i++) candidates.push(letters[0] + letters[i]);
  return candidates.find((c) => !used.includes(c)) || '';
}

/**
 * Dialog to add a new Type of Store / Ledger. With `parent` (a ledger object) it adds a sub-ledger under it.
 * Calls onAdded(ledger) after meta is reloaded.
 */
export default function AddLedgerModal({ onClose, onAdded, parent }) {
  const { meta, reloadMeta } = useApp();
  const toast = useToast();
  const used = (meta.allLedgers || meta.ledgers).map((l) => l.prefix);
  const [label, setLabel] = useState('');
  const [prefix, setPrefix] = useState('');
  const [prefixTouched, setPrefixTouched] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const shownPrefix = prefixTouched ? prefix : suggestPrefix(label, used);
  const preview = label.trim() ? (/ledger$/i.test(label.trim()) ? label.trim() : `${label.trim()} Ledger`) : '';

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { ledger } = await api.post('/settings/ledgers', { label, prefix: shownPrefix, ...(parent && { parent: parent.key }) });
      await reloadMeta();
      toast.success(`${ledger.label} added`);
      onAdded?.(ledger);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={parent ? `Add Sub-Ledger under ${parent.label}` : 'Add Type of Store / Ledger'} onClose={onClose} size="sm">
      <form onSubmit={submit} style={{ display: 'grid', gap: 12 }}>
        {parent && (
          <div className="note">
            The new ledger will appear under <b>{parent.label}</b>. Choosing {parent.label} on a voucher will then show a second drop-down for its
            sub-ledgers.
          </div>
        )}
        <Field label="Ledger name" required stack>
          <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={parent ? 'e.g. B&R Store' : 'e.g. Electrical'} maxLength={60} autoFocus required />
        </Field>
        <Field label="Item code prefix" required stack>
          <input
            className="input"
            value={shownPrefix}
            onChange={(e) => {
              setPrefixTouched(true);
              setPrefix(e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4));
            }}
            placeholder="e.g. EL"
            required
            minLength={2}
            maxLength={4}
            style={{ width: 120, textTransform: 'uppercase' }}
          />
        </Field>
        {preview && shownPrefix.length >= 2 && (
          <div className="note">
            Will be added as <b>{preview}</b>; items get codes like <b>{shownPrefix}-0001</b>.
          </div>
        )}
        <span className="muted" style={{ fontSize: 13 }}>
          Prefixes already in use: {used.join(', ')}. The prefix cannot be changed later.
        </span>
        {error && <div className="error-text">{error}</div>}
        <button className="btn btn-green" disabled={busy || shownPrefix.length < 2 || label.trim().length < 2}>
          <Plus size={18} /> {parent ? 'Add Sub-Ledger' : 'Add Ledger'}
        </button>
      </form>
    </Modal>
  );
}
