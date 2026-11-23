import { useState } from 'react';
import { api } from '../api.js';
import { useToast } from '../context/ToastContext.jsx';
import { Field, Modal } from './ui.jsx';

export default function ChangePasswordModal({ onClose }) {
  const toast = useToast();
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    if (form.newPassword !== form.confirm) return setError('New passwords do not match');
    setBusy(true);
    setError('');
    try {
      await api.post('/auth/change-password', { currentPassword: form.currentPassword, newPassword: form.newPassword });
      toast.success('Password changed. Other sessions have been signed out.');
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Change Password" onClose={onClose} size="sm">
      <form onSubmit={submit} style={{ display: 'grid', gap: 12 }}>
        <Field label="Current password" required stack>
          <input className="input" type="password" autoComplete="current-password" value={form.currentPassword} onChange={set('currentPassword')} required />
        </Field>
        <Field label="New password" required stack>
          <input className="input" type="password" autoComplete="new-password" value={form.newPassword} onChange={set('newPassword')} required minLength={8} />
        </Field>
        <Field label="Confirm new password" required stack>
          <input className="input" type="password" autoComplete="new-password" value={form.confirm} onChange={set('confirm')} required />
        </Field>
        <span className="muted">At least 8 characters, with letters and numbers.</span>
        {error && <div className="error-text">{error}</div>}
        <button className="btn btn-blue" disabled={busy}>
          Change password
        </button>
      </form>
    </Modal>
  );
}
