import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, CalendarDays, X, FileSpreadsheet, FileText, Printer } from 'lucide-react';
import { useApp } from '../context/AppContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { fmtDate } from '../utils/format.js';
import { exportExcel, exportPdf, printSection } from '../utils/export.js';
import { usePrintSignatures } from '../utils/printSign.js';

/** Tick box: print the signature blocks or not (applies to every print; remembered on this computer). */
export function SignToggle({ pill }) {
  const [on, setOn] = usePrintSignatures();
  return (
    <label className={`sign-toggle no-print${pill ? ' pill' : ''}`} title="Tick to print the signature blocks; untick to print without them">
      <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} /> Signature on print
    </label>
  );
}

export function PageHeader({ icon: Icon, title, plainIcon, back = true, extra }) {
  const { meta } = useApp();
  return (
    <div className="page-head no-print">
      <h1>
        {Icon && (
          <span className={`ico ${plainIcon ? 'plain' : ''}`}>
            <Icon size={plainIcon ? 34 : 26} />
          </span>
        )}
        {title}
      </h1>
      <span className="pill">
        <CalendarDays size={18} /> Date : {fmtDate(meta?.today)}
      </span>
      <span className="pill">
        <CalendarDays size={18} /> Financial Year : {meta?.currentFy?.replace('-', ' - ')}
      </span>
      <SignToggle pill />
      {extra}
      {back && (
        <Link to="/" className="btn btn-green btn-lg">
          <ArrowLeft size={20} /> Back to Dashboard
        </Link>
      )}
    </div>
  );
}

export function Panel({ title, icon: Icon, right, light, children, bodyClass = 'panel-body', id, className = '' }) {
  return (
    <section className={`panel ${className}`.trim()} id={id}>
      {title && (
        <div className={`panel-head ${light ? 'light' : ''}`}>
          {Icon && <Icon size={20} />} {title}
          {right && <div className="right">{right}</div>}
        </div>
      )}
      <div className={bodyClass}>{children}</div>
    </section>
  );
}

export function Field({ label, required, children, stack, htmlFor }) {
  return (
    <div className={`field ${stack ? 'stack' : ''}`}>
      <label htmlFor={htmlFor} className={required ? 'req' : ''}>
        {label}
      </label>
      {children}
    </div>
  );
}

export function Select({ options, value, onChange, placeholder, className = 'input', ...rest }) {
  return (
    <select className={className} value={value ?? ''} onChange={(e) => onChange(e.target.value)} {...rest}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) =>
        typeof o === 'string' ? (
          <option key={o} value={o}>
            {o}
          </option>
        ) : (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ),
      )}
    </select>
  );
}

export function Modal({ title, onClose, children, footer, size, printable }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${size || ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head no-print">
          {title}
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={20} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && (
          <div className="modal-foot no-print">
            {printable && <SignToggle />}
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

/** Asks for a reason, then calls onConfirm(reason). */
/** Confirm permanent deletion of a cancelled voucher (admin). */
export function DeleteVoucherDialog({ voucherNo, onConfirm, onClose }) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const submit = async () => {
    setBusy(true);
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Delete ${voucherNo} permanently?`}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Keep
          </button>
          <button type="button" className="btn btn-red" disabled={busy} onClick={submit}>
            {busy ? 'Deleting…' : 'Delete permanently'}
          </button>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>
        <b>{voucherNo}</b> is cancelled. Deleting removes it from the registers for good — this cannot be undone.
      </p>
      <p className="muted" style={{ marginBottom: 0 }}>
        Stock is not affected (cancelling already reversed it). The deletion is recorded in the audit log.
      </p>
    </Modal>
  );
}

export function CancelDialog({ title, onConfirm, onClose }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const submit = async () => {
    setBusy(true);
    try {
      await onConfirm(reason);
      onClose();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={title}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Keep
          </button>
          <button type="button" className="btn btn-red" disabled={busy || reason.trim().length < 3} onClick={submit}>
            Cancel voucher
          </button>
        </>
      }
    >
      <p className="muted" style={{ marginTop: 0 }}>
        Cancelling reverses the stock movement. The voucher stays on record marked as Cancelled.
      </p>
      <Field label="Reason" required stack>
        <textarea className="input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} autoFocus />
      </Field>
    </Modal>
  );
}

export function StatusBadge({ status }) {
  const map = {
    POSTED: ['Posted', 'green'],
    CANCELLED: ['Cancelled', 'red'],
    ACTIVE: ['Active', 'green'],
    INACTIVE: ['Inactive', 'grey'],
    ISSUED: ['Issued', 'orange'],
    PARTIAL: ['Part Returned', 'blue'],
    RETURNED: ['Returned', 'green'],
    RECEIVED: ['Received', 'green'],
    PART_DEPOSITED: ['Part Deposited', 'blue'],
    DEPOSITED: ['Deposited', 'green'],
    OPEN: ['Open', 'red'],
    REPLIED: ['Replied', 'orange'],
    SETTLED: ['Settled', 'green'],
  };
  const [label, color] = map[status] || [status, 'grey'];
  return <span className={`badge badge-${color}`}>{label}</span>;
}

/**
 * Excel / PDF / Print buttons. With `orientable`, a Portrait / Landscape choice is shown and used for Print
 * and PDF (remembered on this computer).
 */
const ORIENT_KEY = 'mes-print-orientation';
const readOrientation = () => {
  try {
    return localStorage.getItem(ORIENT_KEY) === 'landscape' ? 'landscape' : 'portrait';
  } catch {
    return 'portrait';
  }
};
/** Portrait / Landscape choice for printing, remembered on this computer. */
export function usePrintOrientation() {
  const [orientation, setOrientationState] = useState(readOrientation);
  const setOrientation = (v) => {
    setOrientationState(v);
    try {
      localStorage.setItem(ORIENT_KEY, v);
    } catch {
      /* not remembered; still used for this print */
    }
  };
  return [orientation, setOrientation];
}

export function OrientationSelect({ value, onChange }) {
  return (
    <select className="input orient-select" value={value} onChange={(e) => onChange(e.target.value)} title="Page layout for Print and PDF" aria-label="Page layout">
      <option value="portrait">Portrait</option>
      <option value="landscape">Landscape</option>
    </select>
  );
}

export function ExportButtons({ getExport, printId, disabled, orientable }) {
  const { settings } = useApp();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [orientation, setOrientation] = usePrintOrientation();
  const run = async (fn) => {
    setBusy(true);
    try {
      await fn({ ...getExport(), orgTitle: settings.orgTitle, orgSubtitle: settings.orgSubtitle, ...(orientable && { orientation }) });
    } catch (e) {
      toast.error(`Export failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="row no-print">
      <button type="button" className="btn btn-green" disabled={disabled || busy} onClick={() => run(exportExcel)}>
        <FileSpreadsheet size={18} /> Excel
      </button>
      <button type="button" className="btn btn-red" disabled={disabled || busy} onClick={() => run(exportPdf)}>
        <FileText size={18} /> PDF
      </button>
      {orientable && <OrientationSelect value={orientation} onChange={setOrientation} />}
      <button
        type="button"
        className="btn btn-outline"
        disabled={disabled}
        onClick={() => printSection(printId, orientable ? { orientation } : undefined)}
      >
        <Printer size={18} /> Print
      </button>
    </div>
  );
}

/** Heading shown on printed documents. */
export function DocHeader({ title, subtitle }) {
  const { settings } = useApp();
  return (
    <div className="doc-head">
      <h2>{settings.orgTitle}</h2>
      <h3>{settings.orgSubtitle}</h3>
      <h4>{title}</h4>
      {subtitle && <div style={{ fontSize: 13, marginTop: 4 }}>{subtitle}</div>}
    </div>
  );
}

/** Heading on printed ledger reports: ledger name, then unit/office and the as-on date. */
export function LedgerPrintHeader({ ledger, asOn }) {
  const { settings } = useApp();
  return (
    <div className="ledger-print-head">
      <div>LEDGER: {ledger}</div>
      <div className="ledger-print-row">
        <span>Unit/office:- {settings.orgTitle}</span>
        <span>As on date: {asOn}</span>
      </div>
    </div>
  );
}

export function Loading({ text = 'Loading…' }) {
  return <div className="spinner-page">{text}</div>;
}
