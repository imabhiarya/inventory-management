import { useState } from 'react';
import { ShoppingCart, ClipboardList, BarChart3, Plus, Trash2, Save, RotateCcw, Search, Pencil, Eye, X, FileUp, FileDown, FileSpreadsheet, CheckCircle2, AlertTriangle, IndianRupee } from 'lucide-react';
import { readOrderFile, downloadOrdersExcel } from '../utils/orderImport.js';
import { api } from '../api.js';
import { useApp } from '../context/AppContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { useFetch } from '../hooks.js';
import { PageHeader, Panel, Field, Select, Modal, ExportButtons, LedgerPrintHeader } from '../components/ui.jsx';
import { fmtDate, fmtMoney, fmtQty, fyOptions } from '../utils/format.js';

/** Financial year (Apr–Mar) of a yyyy-mm-dd date, e.g. 2026-11-21 → "2026-27". */
const fyOf = (iso) => {
  if (!iso) return '';
  const y = Number(iso.slice(0, 4));
  const start = Number(iso.slice(5, 7)) >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
};

const DEFAULT_MODES = ['GeM', 'Local Purchase', 'Limited Tender', 'Open Tender', 'Single Tender', 'Other'];
export const ORDER_STATUS = {
  ORDERED: ['Ordered', 'blue'],
  DELIVERED: ['Delivered', 'orange'],
  BILL_FORWARDED: ['Bill Forwarded', 'purple'],
  PAID: ['Paid', 'green'],
  CANCELLED: ['Cancelled', 'red'],
};
/** Orders drop-down list from Settings ("Orders – Drop-down Lists"), keeping a saved value that is no longer listed. */
const orderList = (settings, key, fallback = []) => (settings[key]?.length ? settings[key] : fallback);
/** The "Project contingency" code head also asks which Office it is for. */
const isProjectContingency = (codeHead) => /project\s*contingency/i.test(codeHead || '');
const withCurrent = (list, value) => (value && !list.includes(value) ? [value, ...list] : list);
const StatusPill = ({ s }) => <span className={`badge badge-${ORDER_STATUS[s]?.[1] || 'grey'}`}>{ORDER_STATUS[s]?.[0] || s}</span>;
const day = (v) => (v ? String(v).slice(0, 10) : '');
const blankLine = { description: '', qty: '', uom: '', rate: '' };

function blankOrder(today) {
  return {
    mode: 'GeM', supplyOrderNo: '', gemOrderId: '', orderDate: today, vendor: '', vendorGstin: '',
    demandNo: '', demandDate: '', demandFrom: '', approvalDate: '', approvedBy: '', notingNo: '', notingDate: '',
    codeHead: '', projectOffice: '', budgetYear: fyOf(today), ledger: '', lines: [], orderValue: '',
    expectedDelivery: '', deliveredOn: '', receiptRef: '',
    billNo: '', billDate: '', billAmount: '', billForwardedOn: '', accountsOffice: '', forwardingLetterNo: '',
    paymentDate: '', paymentAmount: '', paymentRef: '', cancelled: false, remarks: '',
  };
}
const fromOrder = (o) => ({
  ...blankOrder(''),
  ...o,
  ...Object.fromEntries(['orderDate', 'demandDate', 'approvalDate', 'notingDate', 'expectedDelivery', 'deliveredOn', 'billDate', 'billForwardedOn', 'paymentDate'].map((k) => [k, day(o[k])])),
  lines: (o.lines || []).map((l) => ({ description: l.description, qty: l.qty, uom: l.uom, rate: l.rate })),
  orderValue: o.lines?.length ? '' : o.orderValue || '',
  billAmount: o.billAmount || '',
  paymentAmount: o.paymentAmount || '',
});

/** A titled block of fields inside the order form. */
const Section = ({ title, children }) => (
  <fieldset className="order-section">
    <legend>{title}</legend>
    <div className="grid-2">{children}</div>
  </fieldset>
);

/** Order entry / edit form. */
function OrderForm({ editing, onSaved, onCancelEdit, onLoad }) {
  const { meta, settings, ledgerLabel, canWrite } = useApp();
  const toast = useToast();
  const modes = settings.procurementModes?.length ? settings.procurementModes : DEFAULT_MODES;
  const [f, setF] = useState(() => (editing ? fromOrder(editing) : blankOrder(meta.today)));
  const [line, setLine] = useState(blankLine);
  const [busy, setBusy] = useState(false);
  const [finding, setFinding] = useState(null); // { q, matches } while searching for an order to update
  const [importing, setImporting] = useState(false);

  /**
   * Find a saved order and open it in the form (every box filled) for updating. An exact Order No. or
   * Supply Order / Contract No. — or a single match — opens straight away; several matches show a list.
   */
  const findOrder = async (text) => {
    const q = text.trim();
    if (!q) return toast.error('Type an Order No. or Supply Order / Contract No. to search');
    try {
      const { rows } = await api.get('/orders', { q });
      const lc = q.toLowerCase();
      const exact = rows.find((r) => r.orderNo.toLowerCase() === lc || (r.supplyOrderNo || '').toLowerCase() === lc);
      if (exact || rows.length === 1) {
        setFinding(null);
        onLoad(exact || rows[0]);
        toast.success(`Order ${(exact || rows[0]).orderNo} loaded — make changes and press Save Changes`);
      } else setFinding({ q, matches: rows });
    } catch (err) {
      toast.error(err.message);
    }
  };
  const set = (k) => (v) => setF((s) => ({ ...s, [k]: v?.target ? (v.target.type === 'checkbox' ? v.target.checked : v.target.value) : v }));
  const linesTotal = f.lines.reduce((s, l) => s + Number(l.qty || 0) * Number(l.rate || 0), 0);
  const value = f.lines.length ? linesTotal : Number(f.orderValue || 0);

  const addLine = () => {
    if (!line.description.trim()) return toast.error('Enter the item description');
    setF((s) => ({ ...s, lines: [...s.lines, { ...line, qty: Number(line.qty || 0), rate: Number(line.rate || 0) }] }));
    setLine(blankLine);
  };
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const body = { ...f, orderValue: Number(f.orderValue || 0), billAmount: Number(f.billAmount || 0), paymentAmount: Number(f.paymentAmount || 0) };
      delete body._id;
      for (const k of ['orderNo', 'status', 'createdAt', 'updatedAt', 'createdBy', '__v']) delete body[k];
      const { order } = editing ? await api.put(`/orders/${editing._id}`, body) : await api.post('/orders', body);
      toast.success(`Order ${order.orderNo} ${editing ? 'updated' : 'saved'}`);
      onSaved(order);
      if (!editing) setF(blankOrder(meta.today));
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };
  const inp = (k, props = {}) => <input className="input" value={f[k]} onChange={set(k)} {...props} />;
  const date = (k) => <input className="input" type="date" value={f[k]} onChange={set(k)} />;

  return (
    <Panel title={editing ? `Edit Order ${editing.orderNo}` : 'Order Entry'} icon={ClipboardList}>
      <form onSubmit={save} className="order-form">
        <Section title="Order">
          <Field label="Budget / Financial Year">
            <Select value={f.budgetYear} onChange={set('budgetYear')} options={fyOptions(meta.currentFy, 10)} />
          </Field>
          <Field label="Mode of Procurement" required>
            <Select value={f.mode} onChange={set('mode')} options={modes} />
          </Field>
          <Field label="Order Date" required>
            <input
              className="input"
              type="date"
              value={f.orderDate}
              // The budget / financial year follows the order date unless it was changed by hand.
              onChange={(e) => {
                const v = e.target.value;
                setF((s) => ({ ...s, orderDate: v, budgetYear: !s.budgetYear || s.budgetYear === fyOf(s.orderDate) ? fyOf(v) : s.budgetYear }));
              }}
            />
          </Field>
          <Field label="Supply Order / Contract No.">
            {/* Search a saved order by its contract no. (button or Enter) and fill every box for updating. */}
            <div className="input-with-btn">
              <input
                className="input"
                value={f.supplyOrderNo}
                onChange={set('supplyOrderNo')}
                maxLength={120}
                placeholder="e.g. GEMC-511687-7000-01"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    findOrder(f.supplyOrderNo);
                  }
                }}
              />
              <button type="button" className="btn btn-blue" title="Search saved order by this Supply Order / Contract No." onClick={() => findOrder(f.supplyOrderNo)}>
                <Search size={16} /> Search
              </button>
            </div>
          </Field>
          <Field label="Firm / Vendor" required>
            {inp('vendor', { maxLength: 200, required: true, placeholder: 'e.g. M/S Raj Enterprises' })}
          </Field>
        </Section>

        <Section title="Demand">
          <Field label="Demand No.">{inp('demandNo', { maxLength: 80 })}</Field>
          <Field label="Demand Date">{date('demandDate')}</Field>
          <Field label="Demand From (Unit / Section)">
            <Select value={f.demandFrom} onChange={set('demandFrom')} placeholder="— Select —" options={withCurrent(orderList(settings, 'orderDemandFrom', settings.units), f.demandFrom)} />
          </Field>
        </Section>

        <Section title="Approval (Commander / CFA)">
          <Field label="Approval Date">{date('approvalDate')}</Field>
          <Field label="Approved By">
            <Select value={f.approvedBy} onChange={set('approvedBy')} placeholder="— Select —" options={withCurrent(orderList(settings, 'orderApprovers'), f.approvedBy)} />
          </Field>
          <Field label="Noting No.">{inp('notingNo', { maxLength: 80 })}</Field>
          <Field label="Noting Date">{date('notingDate')}</Field>
        </Section>

        <Section title="Funds">
          <Field label="Code Head">
            <Select
              value={f.codeHead}
              // Leaving Project contingency clears its Office.
              onChange={(v) => setF((s) => ({ ...s, codeHead: v, projectOffice: isProjectContingency(v) ? s.projectOffice : '' }))}
              placeholder="— Select —"
              options={withCurrent(orderList(settings, 'orderCodeHeads'), f.codeHead)}
            />
          </Field>
          {isProjectContingency(f.codeHead) && (
            <Field label="Office" required>
              <Select
                className="input highlight"
                value={f.projectOffice}
                onChange={set('projectOffice')}
                placeholder="— Select Office —"
                options={withCurrent(orderList(settings, 'orderProjectOffices'), f.projectOffice)}
              />
            </Field>
          )}
          <Field label="Ledger (reference)">
            <Select value={f.ledger} onChange={set('ledger')} placeholder="— Not specific —" options={meta.ledgers.map((l) => ({ value: l.key, label: ledgerLabel(l.key) }))} />
          </Field>
        </Section>

        <fieldset className="order-section">
          <legend>Items Ordered</legend>
          {canWrite && (
            <div className="filters" style={{ marginBottom: 8 }}>
              <div className="field stack grow">
                <label>Item Description</label>
                <input className="input" value={line.description} onChange={(e) => setLine({ ...line, description: e.target.value })} maxLength={300} />
              </div>
              <Field label="Qty" stack>
                <input className="input" type="number" min="0" step="any" value={line.qty} onChange={(e) => setLine({ ...line, qty: e.target.value })} style={{ width: 100 }} />
              </Field>
              <Field label="UoM" stack>
                <Select value={line.uom} onChange={(v) => setLine({ ...line, uom: v })} placeholder="—" options={orderList(settings, 'orderUoms', settings.uoms)} style={{ width: 110 }} />
              </Field>
              <Field label="Rate (₹)" stack>
                <input className="input" type="number" min="0" step="any" value={line.rate} onChange={(e) => setLine({ ...line, rate: e.target.value })} style={{ width: 120 }} />
              </Field>
              <button type="button" className="btn btn-green" onClick={addLine}>
                <Plus size={16} /> Add
              </button>
            </div>
          )}
          <table className="data">
            <thead>
              <tr>
                <th>Sl.</th>
                <th>Item Description</th>
                <th className="num">Qty</th>
                <th>UoM</th>
                <th className="num">Rate (₹)</th>
                <th className="num">Amount (₹)</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {f.lines.map((l, i) => (
                <tr key={i}>
                  <td className="center">{i + 1}</td>
                  <td>{l.description}</td>
                  <td className="num">{fmtQty(l.qty)}</td>
                  <td className="center">{l.uom}</td>
                  <td className="num">{fmtMoney(l.rate)}</td>
                  <td className="num">{fmtMoney(l.qty * l.rate)}</td>
                  <td className="center">
                    <button type="button" className="icon-btn del" title="Remove" onClick={() => setF((s) => ({ ...s, lines: s.lines.filter((_, j) => j !== i) }))}>
                      <Trash2 size={16} />
                    </button>
                  </td>
                </tr>
              ))}
              {!f.lines.length && (
                <tr>
                  <td colSpan={7} className="empty">
                    No items added — or enter the total order value below.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <div className="row" style={{ justifyContent: 'flex-end', gap: 12, marginTop: 8, alignItems: 'center' }}>
            {!f.lines.length && (
              <Field label="Order Value (₹)">
                <input className="input" type="number" min="0" step="any" value={f.orderValue} onChange={set('orderValue')} style={{ width: 160 }} />
              </Field>
            )}
            <b className="order-total">Total Order Value: ₹ {fmtMoney(value)}</b>
          </div>
        </fieldset>

        <Section title="Delivery (reference)">
          <Field label="Expected Delivery">{date('expectedDelivery')}</Field>
          <Field label="Delivered On">{date('deliveredOn')}</Field>
          <Field label="CRV / Receipt Ref.">{inp('receiptRef', { maxLength: 120, placeholder: 'e.g. R-000012' })}</Field>
        </Section>

        <Section title="Bill → Accounts Office">
          <Field label="Bill No.">{inp('billNo', { maxLength: 80 })}</Field>
          <Field label="Bill Date">{date('billDate')}</Field>
          <Field label="Bill Amount (₹)">
            <input className="input" type="number" min="0" step="any" value={f.billAmount} onChange={set('billAmount')} />
          </Field>
          <Field label="Forwarded to Accounts On">{date('billForwardedOn')}</Field>
          <Field label="Accounts Office">
            <Select value={f.accountsOffice} onChange={set('accountsOffice')} placeholder="— Select —" options={withCurrent(orderList(settings, 'orderAccountsOffices'), f.accountsOffice)} />
          </Field>
          <Field label="Forwarding Letter No.">{inp('forwardingLetterNo', { maxLength: 120 })}</Field>
        </Section>

        <Section title="Payment">
          <Field label="Payment Date">{date('paymentDate')}</Field>
          <Field label="Amount Paid (₹)">
            <input className="input" type="number" min="0" step="any" value={f.paymentAmount} onChange={set('paymentAmount')} />
          </Field>
          <Field label="DV / Cheque / e-Payment No.">{inp('paymentRef', { maxLength: 120 })}</Field>
        </Section>

        <div className="grid-2" style={{ marginTop: 6 }}>
          <Field label="Remarks">{inp('remarks', { maxLength: 1000 })}</Field>
          <label className="row" style={{ gap: 8, alignItems: 'center', fontWeight: 600 }}>
            <input type="checkbox" checked={f.cancelled} onChange={set('cancelled')} /> Order cancelled
          </label>
        </div>

        {canWrite && (
          <div className="row" style={{ gap: 10, justifyContent: 'center', marginTop: 12 }}>
            <button className="btn btn-green btn-lg" disabled={busy}>
              <Save size={18} /> {busy ? 'Saving…' : editing ? 'Save Changes' : 'Save Order'}
            </button>
            <button type="button" className="btn btn-outline btn-lg" onClick={() => (editing ? onCancelEdit() : setF(blankOrder(meta.today)))}>
              <RotateCcw size={18} /> {editing ? 'Cancel Edit' : 'Clear'}
            </button>
            <button type="button" className="btn btn-blue btn-lg" onClick={() => setFinding({ q: '', matches: null })}>
              <Search size={18} /> Update Order
            </button>
            <button type="button" className="btn btn-purple btn-lg" onClick={() => setImporting(true)}>
              <FileUp size={18} /> Import / Export
            </button>
          </div>
        )}
      </form>
      {importing && (
        <ImportExportModal
          onClose={(imported) => {
            setImporting(false);
            if (imported) onSaved(null); // show the Order Report with the imported orders
          }}
        />
      )}
      {finding && (
        <Modal title="Update Order – find the order" size="sm" onClose={() => setFinding(null)}>
          <form
            className="row"
            style={{ gap: 8, flexWrap: 'nowrap' }}
            onSubmit={(e) => {
              e.preventDefault();
              findOrder(finding.q);
            }}
          >
            <input
              className="input"
              autoFocus
              value={finding.q}
              onChange={(e) => setFinding({ q: e.target.value, matches: null })}
              placeholder="Order No. (e.g. ORD-000001), supply order / demand / bill no. or vendor"
            />
            <button className="btn btn-blue">
              <Search size={16} /> Find
            </button>
          </form>
          {finding.matches && (
            <div style={{ marginTop: 10 }}>
              {finding.matches.length ? (
                <ul className="link-list order-matches">
                  {finding.matches.map((o) => (
                    <li key={o._id}>
                      <button
                        type="button"
                        onClick={() => {
                          setFinding(null);
                          onLoad(o);
                        }}
                      >
                        <b>{o.orderNo}</b> · {fmtDate(o.orderDate)} · {o.vendor} · ₹ {fmtMoney(o.orderValue)} <StatusPill s={o.status} />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="muted">No order found for "{finding.q}".</span>
              )}
            </div>
          )}
        </Modal>
      )}
    </Panel>
  );
}

/**
 * Import orders from GeM / Excel (.xlsx), CSV or Word (.docx) files, with a preview showing which are new
 * and which already exist (matched by Supply Order / Contract No., else GeM Order ID — never duplicated).
 * Also exports all orders to Excel in the same layout, and a blank template.
 */
function ImportExportModal({ onClose }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [parsed, setParsed] = useState(null); // { name, orders, plan }
  const [result, setResult] = useState(null);

  const pick = async (file) => {
    if (!file) return;
    setBusy(true);
    setResult(null);
    try {
      const orders = await readOrderFile(file);
      if (!orders.length) throw new Error('No orders found in the file.');
      const { plan } = await api.post('/orders/import', { orders, dryRun: true });
      setParsed({ name: file.name, orders, plan });
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
      const { plan } = await api.post('/orders/import', { orders: parsed.orders });
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
  const exportAll = async () => {
    setBusy(true);
    try {
      const { rows } = await api.get('/orders');
      if (!rows.length) return toast.error('No orders to export yet');
      await downloadOrdersExcel(rows, `orders-${new Date().toISOString().slice(0, 10)}.xlsx`);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  const ACTION = { create: ['New', 'green'], update: ['Update', 'blue'], error: ['Skipped', 'red'] };
  const plan = parsed?.plan || result?.plan;

  return (
    <Modal title="Import / Export Orders" onClose={() => onClose(!!result)} size="lg">
      <div className="order-import">
        <div className="order-import-box">
          <FileUp size={28} />
          <div>
            <b>Import from GeM / Excel / Word</b>
            <div className="muted" style={{ fontSize: 13 }}>
              Excel (.xlsx), CSV or Word (.docx). Columns or labels like <i>Contract No, Order Date, Seller, Item, Qty, Unit Price</i> are recognised automatically.
              Orders are matched by <b>Supply Order / Contract No.</b>: an existing order is <b>updated</b>, never duplicated.
            </div>
          </div>
          <label className="btn btn-blue" style={{ cursor: busy ? 'progress' : 'pointer' }}>
            <FileSpreadsheet size={16} /> {busy ? 'Reading…' : 'Choose File'}
            <input type="file" hidden accept=".xlsx,.csv,.docx" disabled={busy} onChange={(e) => (pick(e.target.files[0]), (e.target.value = ''))} />
          </label>
        </div>

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
            <div className="table-wrap" style={{ maxHeight: 320 }}>
              <table className="data">
                <thead>
                  <tr>
                    <th>Sl.</th>
                    <th>Supply Order / Contract No.</th>
                    <th>Firm / Vendor</th>
                    <th>Items</th>
                    <th className="num">Value (₹)</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.map((p, i) => (
                    <tr key={i}>
                      <td className="center">{i + 1}</td>
                      <td>{p.label}</td>
                      <td>{p.vendor || parsed?.orders[p.index]?.vendor || '-'}</td>
                      <td className="center">{parsed?.orders[p.index]?.lines.length ?? '-'}</td>
                      <td className="num">{p.orderValue != null ? fmtMoney(p.orderValue) : '-'}</td>
                      <td>
                        <span className={`badge badge-${ACTION[p.action][1]}`}>{ACTION[p.action][0]}</span>
                        {p.action === 'update' && <span className="muted"> {p.orderNo}</span>}
                        {p.action === 'create' && p.orderNo && <span className="muted"> {p.orderNo}</span>}
                        {p.error && <div className="error-text" style={{ fontSize: 12.5 }}>{p.error}</div>}
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
                <button type="button" className="btn btn-green" disabled={busy || !parsed.plan.some((p) => p.action !== 'error')} onClick={doImport}>
                  <CheckCircle2 size={16} /> Import {parsed.plan.filter((p) => p.action !== 'error').length} Order(s)
                </button>
              </div>
            )}
            {parsed?.plan.some((p) => p.action === 'error') && (
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                <AlertTriangle size={14} style={{ verticalAlign: -2 }} /> Skipped rows are not imported; fix them in the file (usually a missing contract no., order date or vendor) and import again.
              </p>
            )}
          </>
        )}

        <h5 className="audit-h">Export</h5>
        <div className="row" style={{ gap: 8 }}>
          <button type="button" className="btn btn-green" disabled={busy} onClick={exportAll}>
            <FileDown size={16} /> Export All Orders (Excel)
          </button>
          <button type="button" className="btn btn-outline" disabled={busy} onClick={() => downloadOrdersExcel([], 'order-import-template.xlsx')}>
            <FileSpreadsheet size={16} /> Download Import Template
          </button>
        </div>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          The export uses the same columns as the import template, so it can be edited in Excel and imported back — orders are updated, not duplicated.
        </p>
      </div>
    </Modal>
  );
}

/** Read-only view of one order. */
function OrderView({ order, onClose }) {
  const { ledgerLabel, settings } = useApp();
  const row = (label, value) => (
    <div>
      <span>{label}</span> {value || '—'}
    </div>
  );
  const head = settings.codeHeads.find((c) => c.code === order.codeHead); // older orders saved just the code
  return (
    <Modal title={`Order ${order.orderNo}`} onClose={onClose} size="lg">
      <div className="audit-meta">
        {row('Status', <StatusPill s={order.status} />)}
        {row('Mode', order.mode)}
        {row('Supply Order / Contract No.', order.supplyOrderNo)}
        {row('Order Date', fmtDate(order.orderDate))}
        {row('Firm / Vendor', <b>{order.vendor}</b>)}
        {row('Demand No. & Date', [order.demandNo, fmtDate(order.demandDate)].filter(Boolean).join(' · '))}
        {row('Demand From', order.demandFrom)}
        {row('Approval Date', fmtDate(order.approvalDate))}
        {row('Approved By', order.approvedBy)}
        {row('Noting No. & Date', [order.notingNo, fmtDate(order.notingDate)].filter(Boolean).join(' · '))}
        {row('Code Head', head ? `${head.code} – ${head.name}` : order.codeHead)}
        {order.projectOffice && row('Office (Project contingency)', order.projectOffice)}
        {row('Budget / Financial Year', order.budgetYear)}
        {row('Ledger', order.ledger && ledgerLabel(order.ledger))}
        {row('Order Value', `₹ ${fmtMoney(order.orderValue)}`)}
        {row('Delivered On', fmtDate(order.deliveredOn))}
        {row('CRV / Receipt Ref.', order.receiptRef)}
        {row('Bill No. & Date', [order.billNo, fmtDate(order.billDate)].filter(Boolean).join(' · '))}
        {row('Bill Amount', order.billAmount ? `₹ ${fmtMoney(order.billAmount)}` : '')}
        {row('Forwarded to Accounts', [fmtDate(order.billForwardedOn), order.accountsOffice].filter(Boolean).join(' · '))}
        {row('Forwarding Letter No.', order.forwardingLetterNo)}
        {row('Payment', [fmtDate(order.paymentDate), order.paymentAmount ? `₹ ${fmtMoney(order.paymentAmount)}` : '', order.paymentRef].filter(Boolean).join(' · '))}
        <div className="wide">
          <span>Remarks</span> {order.remarks || '—'}
        </div>
      </div>
      {order.lines?.length > 0 && (
        <table className="data" style={{ marginTop: 10 }}>
          <thead>
            <tr>
              <th>Sl.</th>
              <th>Item Description</th>
              <th className="num">Qty</th>
              <th>UoM</th>
              <th className="num">Rate (₹)</th>
              <th className="num">Amount (₹)</th>
            </tr>
          </thead>
          <tbody>
            {order.lines.map((l, i) => (
              <tr key={i}>
                <td className="center">{i + 1}</td>
                <td>{l.description}</td>
                <td className="num">{fmtQty(l.qty)}</td>
                <td className="center">{l.uom}</td>
                <td className="num">{fmtMoney(l.rate)}</td>
                <td className="num">{fmtMoney(l.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

/** Order Report: filters, totals, register with Excel / PDF / Print. */
function OrderReport({ onEdit, link, onLink, onPayments }) {
  const { settings, canWrite, isAdmin, meta } = useApp();
  const toast = useToast();
  const modes = settings.procurementModes?.length ? settings.procurementModes : DEFAULT_MODES;
  // FY and code head come from (and go back to) the Payments (MER) tab.
  const [f, setF] = useState(() => ({
    fy: link?.fy || '',
    status: '',
    mode: '',
    codeHead: link?.codeHead === NO_HEAD_VALUE ? '' : link?.codeHead || '',
    from: '',
    to: '',
    q: '',
  }));
  const [applied, setApplied] = useState(f);
  const { data, loading, reload } = useFetch('/orders', applied);
  const rows = data?.rows || [];
  const t = data?.totals;
  const [viewing, setViewing] = useState(null);
  const [removing, setRemoving] = useState(null);

  const columns = [
    { key: 'sl', label: 'Sl.', value: (r) => rows.indexOf(r) + 1 },
    { key: 'orderNo', label: 'Order No.' },
    { key: 'orderDate', label: 'Order Date', format: fmtDate },
    { key: 'mode', label: 'Mode' },
    { key: 'supplyOrderNo', label: 'Supply Order / Contract No.', width: 22 },
    { key: 'vendor', label: 'Firm / Vendor', width: 24 },
    { key: 'demand', label: 'Demand No. & Date', value: (r) => [r.demandNo, fmtDate(r.demandDate)].filter(Boolean).join(' · '), width: 18 },
    { key: 'demandFrom', label: 'Demand From', width: 18 },
    { key: 'approval', label: 'Approval / Noting', value: (r) => [fmtDate(r.approvalDate), r.notingNo && `Noting ${r.notingNo}`, fmtDate(r.notingDate)].filter(Boolean).join(' · '), width: 22 },
    { key: 'budgetYear', label: 'FY' },
    { key: 'codeHead', label: 'Code Head', value: (r) => (r.projectOffice ? `${r.codeHead} (${r.projectOffice})` : r.codeHead), width: 18 },
    { key: 'orderValue', label: 'Order Value (₹)', align: 'right', numeric: true, format: fmtMoney },
    { key: 'bill', label: 'Bill No. & Date', value: (r) => [r.billNo, fmtDate(r.billDate)].filter(Boolean).join(' · '), width: 18 },
    { key: 'forwarded', label: 'Fwd to Accounts / Letter No.', value: (r) => [fmtDate(r.billForwardedOn), r.accountsOffice, r.forwardingLetterNo].filter(Boolean).join(' · '), width: 24 },
    { key: 'payment', label: 'Payment', value: (r) => [fmtDate(r.paymentDate), r.paymentAmount ? `₹ ${fmtMoney(r.paymentAmount)}` : '', r.paymentRef].filter(Boolean).join(' · '), width: 22 },
    { key: 'status', label: 'Status', value: (r) => ORDER_STATUS[r.status]?.[0] || r.status },
  ];

  return (
    <Panel
      title="Order Report"
      icon={BarChart3}
      id="order-report-print"
      right={
        <ExportButtons
          orientable
          printId="order-report-print"
          disabled={!rows.length}
          getExport={() => ({
            title: 'Order Report',
            subtitle: `${applied.fy ? `FY ${applied.fy} · ` : ''}${applied.from ? fmtDate(applied.from) : 'All dates'}${applied.to ? ` to ${fmtDate(applied.to)}` : ''}`,
            columns,
            rows,
            filename: `order-report${applied.fy ? `-fy-${applied.fy}` : ''}`,
          })}
        />
      }
    >
      <form
        className="filters no-print"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(f);
          onLink?.(f.fy, f.codeHead);
        }}
      >
        <Field label="Financial Year" stack>
          <Select value={f.fy} onChange={(v) => setF({ ...f, fy: v })} placeholder="All Years" options={fyOptions(meta.currentFy, 10)} />
        </Field>
        <Field label="Status" stack>
          <Select
            value={f.status}
            onChange={(v) => setF({ ...f, status: v })}
            placeholder="All"
            options={[...Object.entries(ORDER_STATUS).map(([value, [label]]) => ({ value, label })), { value: 'PENDING_PAYMENT', label: 'Payment Pending' }]}
          />
        </Field>
        <Field label="Mode" stack>
          <Select value={f.mode} onChange={(v) => setF({ ...f, mode: v })} placeholder="All" options={modes} />
        </Field>
        <Field label="Code Head" stack>
          <Select value={f.codeHead} onChange={(v) => setF({ ...f, codeHead: v })} placeholder="All" options={orderList(settings, 'orderCodeHeads')} />
        </Field>
        <Field label="From" stack>
          <input className="input" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
        </Field>
        <Field label="To" stack>
          <input className="input" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
        </Field>
        <div className="field stack grow">
          <label>Search</label>
          <input className="input" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} placeholder="Order / supply order / demand / bill no., vendor, item" />
        </div>
        <button className="btn btn-blue">
          <Search size={18} /> View Report
        </button>
        <button
          type="button"
          className="btn btn-outline"
          title="Month-wise payments for this FY and code head"
          onClick={() => onPayments?.(f.fy || meta.currentFy, f.codeHead)}
        >
          <IndianRupee size={18} /> Payments (MER)
        </button>
      </form>
      <div className="print-doc">
        <LedgerPrintHeader ledger={`ORDER REPORT${applied.fy ? ` – FY ${applied.fy}` : ''}`} asOn={fmtDate(new Date())} />
      </div>
      {t && (
        <div className="order-totals">
          <span>
            Orders: <b>{t.orders}</b>
          </span>
          <span>
            Order Value: <b>₹ {fmtMoney(t.orderValue)}</b>
          </span>
          <span>
            Billed: <b>₹ {fmtMoney(t.billAmount)}</b>
          </span>
          <span>
            Paid: <b>₹ {fmtMoney(t.paymentAmount)}</b>
          </span>
          <span className="pending">
            Balance to Pay: <b>₹ {fmtMoney(Math.max(0, t.orderValue - t.paymentAmount))}</b>
          </span>
        </div>
      )}
      <div className="table-wrap" style={{ marginTop: 10 }}>
        <table className="data">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key} className={c.align === 'right' ? 'num' : undefined}>
                  {c.label}
                </th>
              ))}
              <th className="no-print">Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r._id}>
                {columns.map((c) => {
                  const raw = c.value ? c.value(r) : r[c.key];
                  const shown = c.key === 'status' ? <StatusPill s={r.status} /> : c.format ? c.format(raw) : raw;
                  return (
                    <td key={c.key} className={c.align === 'right' ? 'num' : ['sl', 'orderNo', 'orderDate', 'mode', 'budgetYear', 'codeHead', 'status'].includes(c.key) ? 'center' : undefined}>
                      {c.key === 'sl' ? i + 1 : shown || '-'}
                    </td>
                  );
                })}
                <td className="center no-print" style={{ whiteSpace: 'nowrap' }}>
                  <button type="button" className="icon-btn" title="View" onClick={() => setViewing(r)}>
                    <Eye size={18} />
                  </button>
                  {canWrite && (
                    <button type="button" className="icon-btn edit" title="Edit / update bill & payment" onClick={() => onEdit(r)}>
                      <Pencil size={18} />
                    </button>
                  )}
                  {isAdmin && !r.paymentDate && (
                    <button type="button" className="icon-btn del" title="Delete" onClick={() => setRemoving(r)}>
                      <Trash2 size={18} />
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={columns.length + 1} className="empty">
                  {loading ? 'Loading…' : 'No orders recorded.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {viewing && <OrderView order={viewing} onClose={() => setViewing(null)} />}
      {removing && (
        <Modal
          title={`Delete order ${removing.orderNo}?`}
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
                    await api.del(`/orders/${removing._id}`);
                    toast.success(`${removing.orderNo} deleted`);
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
          This removes the order record for good. Use "Order cancelled" instead if you only want to mark it cancelled.
        </Modal>
      )}
    </Panel>
  );
}

const NO_HEAD = '(No code head)';
const round2 = (n) => Math.round(n * 100) / 100;
const NO_HEAD_VALUE = '__none__'; // dropdown value for orders saved without a code head
const headLabel = (h) => h || NO_HEAD;

/**
 * Payments (MER): amount paid in each month of a financial year, per code head.
 * Pick a Code Head and / or a Month to get the statement to send on to the section.
 * FY and code head are shared with the Order Report (`link`), so either opens the other on the same selection.
 */
function PaymentReport({ link, setLink, onOpenOrders }) {
  const { meta, settings } = useApp();
  const { codeHead, month } = link;
  const fy = link.fy || meta.currentFy; // the Order Report may be on "All Years"
  const set = (patch) => setLink({ ...link, ...patch });
  const { data, loading } = useFetch('/orders/payments', { fy });
  const [cell, setCell] = useState(null); // { codeHead, month } whose payments are listed
  const months = data?.months || [];
  const allRows = data?.rows || [];
  const amt = (v) => (v ? fmtMoney(v) : '-');

  // Code head choices: the Orders list, plus any head that has payments this FY but is no longer in it.
  const listed = orderList(settings, 'orderCodeHeads');
  const extra = allRows.map((r) => r.codeHead).filter((h) => h && !listed.includes(h));
  const headOptions = [...listed, ...extra, ...(allRows.some((r) => !r.codeHead) ? [{ value: NO_HEAD_VALUE, label: NO_HEAD }] : [])];
  const headKey = codeHead === NO_HEAD_VALUE ? '' : codeHead;
  const headPicked = codeHead !== '';
  const monthIdx = month ? months.findIndex((m) => m.key === month) : -1;
  const monthLabel = monthIdx >= 0 ? months[monthIdx].label : '';

  const rows = headPicked ? allRows.filter((r) => r.codeHead === headKey) : allRows;
  const total = (r) => (monthIdx >= 0 ? r.months[monthIdx] : r.total);
  const payments = (data?.payments || []).filter((p) => (!headPicked || (p.codeHead || '') === headKey) && (!month || p.month === month));
  const sumPaid = round2(payments.reduce((s, p) => s + p.paymentAmount, 0));
  const scope = [headPicked ? headLabel(headKey) : 'All code heads', monthLabel || `FY ${fy}`].join(' – ');

  // With a month chosen: a statement of that month's payments (what goes to the section).
  // Without: the month-wise matrix (Apr–Mar) per code head.
  const statement = !!month;
  const sl = (list) => (r) => list.indexOf(r) + 1;
  const matrixColumns = [
    { key: 'sl', label: 'Sl.', value: sl(rows) },
    { key: 'codeHead', label: 'Code Head', value: (r) => headLabel(r.codeHead), width: 28 },
    ...months.map((m, i) => ({ key: m.key, label: m.label, align: 'right', numeric: true, value: (r) => r.months[i], format: amt })),
    { key: 'total', label: 'Total (₹)', align: 'right', numeric: true, format: fmtMoney },
  ];
  const monthTotals = months.map((_, i) => round2(rows.reduce((s, r) => s + r.months[i], 0)));
  const matrixFooter = {
    codeHead: 'Total',
    ...Object.fromEntries(months.map((m, i) => [m.key, amt(monthTotals[i])])),
    total: fmtMoney(round2(rows.reduce((s, r) => s + r.total, 0))),
  };
  const statementColumns = [
    { key: 'sl', label: 'Sl.', value: sl(payments) },
    { key: 'paymentDate', label: 'Payment Date', format: fmtDate },
    ...(headPicked ? [] : [{ key: 'codeHead', label: 'Code Head', value: (p) => headLabel(p.codeHead), width: 24 }]),
    { key: 'orderNo', label: 'Order No.' },
    { key: 'supplyOrderNo', label: 'Supply Order / Contract No.', width: 22 },
    { key: 'vendor', label: 'Firm / Vendor', value: (p) => (p.projectOffice ? `${p.vendor} (${p.projectOffice})` : p.vendor), width: 24 },
    { key: 'paymentRef', label: 'Payment Ref. (DV / e-payment)', width: 20 },
    { key: 'paymentAmount', label: 'Amount (₹)', align: 'right', numeric: true, format: fmtMoney },
  ];
  const statementFooter = { [headPicked ? 'orderNo' : 'codeHead']: 'Total', paymentAmount: fmtMoney(sumPaid) };
  const columns = statement ? statementColumns : matrixColumns;
  const exportRows = statement ? payments : rows;

  const cellList = cell
    ? (data?.payments || []).filter((p) => (p.codeHead || '') === cell.codeHead && (!cell.month || p.month === cell.month))
    : [];
  const cellMonth = cell?.month && months.find((m) => m.key === cell.month)?.label;
  const open = (h, m) => setCell({ codeHead: h, month: m });

  return (
    <Panel
      title="Payments (MER) – Month-wise by Code Head"
      icon={BarChart3}
      id="order-payments-print"
      right={
        <ExportButtons
          orientable
          printId="order-payments-print"
          disabled={!exportRows.length}
          getExport={() => ({
            title: statement ? `Payment Statement – ${scope}` : `Payments (MER) – ${scope}`,
            subtitle: statement ? `Total paid: ₹ ${fmtMoney(sumPaid)}` : 'Amount paid in each month (₹), by code head',
            columns,
            rows: exportRows,
            footer: statement ? statementFooter : matrixFooter,
            filename: `payments-${statement ? month : `fy-${fy}`}${headPicked ? `-${(headKey || 'no-code-head').split(/\s/)[0]}` : ''}`,
          })}
        />
      }
    >
      <div className="filters no-print">
        <Field label="Financial Year" stack>
          <Select value={fy} onChange={(v) => v && set({ fy: v, month: '' })} options={fyOptions(meta.currentFy, 10)} />
        </Field>
        <Field label="Code Head" stack>
          <Select value={codeHead} onChange={(v) => set({ codeHead: v })} placeholder="All Code Heads" options={headOptions} />
        </Field>
        <Field label="Month" stack>
          <Select value={month} onChange={(v) => set({ month: v })} placeholder="All Months (Apr–Mar)" options={months.map((m) => ({ value: m.key, label: m.label }))} />
        </Field>
        <button type="button" className="btn btn-outline" style={{ alignSelf: 'end' }} onClick={() => onOpenOrders()} title="Order Report for this FY and code head">
          <ClipboardList size={18} /> Open in Order Report
        </button>
      </div>
      <p className="muted no-print" style={{ margin: '8px 0 0' }}>
        A payment counts in the month of its payment date. Cancelled orders are left out.
        {statement ? '' : ' Click an amount to see its payments, or choose a Month for a statement to send to the section.'}
      </p>
      <div className="print-doc">
        <LedgerPrintHeader ledger={`${statement ? 'PAYMENT STATEMENT' : 'PAYMENTS (MER)'} – ${scope.toUpperCase()}`} asOn={fmtDate(new Date())} />
      </div>
      {data && (
        <div className="order-totals">
          <span>
            Payments: <b>{payments.length}</b>
          </span>
          <span className="pending">
            Paid – {scope}: <b>₹ {fmtMoney(sumPaid)}</b>
          </span>
        </div>
      )}

      {statement && rows.length > 0 && (
        <div className="table-wrap" style={{ marginTop: 10 }}>
          <table className="data" style={{ width: 'auto', minWidth: 420 }}>
            <thead>
              <tr>
                <th>Code Head</th>
                <th className="num">Paid in {monthLabel} (₹)</th>
              </tr>
            </thead>
            <tbody>
              {rows.filter((r) => total(r)).map((r) => (
                <tr key={r.codeHead || NO_HEAD}>
                  <td>{headLabel(r.codeHead)}</td>
                  <td className="num">{fmtMoney(total(r))}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th>Total</th>
                <th className="num">{fmtMoney(sumPaid)}</th>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <div className="table-wrap" style={{ marginTop: 10 }}>
        <table className="data">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key} className={c.align === 'right' ? 'num' : undefined}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          {statement ? (
            <tbody>
              {payments.map((p, i) => (
                <tr key={p._id}>
                  {columns.map((c) => {
                    const raw = c.key === 'sl' ? i + 1 : c.value ? c.value(p) : p[c.key];
                    return (
                      <td key={c.key} className={c.align === 'right' ? 'num' : ['sl', 'paymentDate', 'orderNo'].includes(c.key) ? 'center' : undefined}>
                        {(c.format ? c.format(raw) : raw) || '-'}
                      </td>
                    );
                  })}
                </tr>
              ))}
              {!payments.length && (
                <tr>
                  <td colSpan={columns.length} className="empty">
                    {loading ? 'Loading…' : `No payments – ${scope}.`}
                  </td>
                </tr>
              )}
            </tbody>
          ) : (
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.codeHead || NO_HEAD}>
                  <td className="center">{i + 1}</td>
                  <td>{r.codeHead || <i>{NO_HEAD}</i>}</td>
                  {months.map((m, j) => (
                    <td key={m.key} className="num">
                      {r.months[j] ? (
                        <button type="button" className="link-btn" onClick={() => open(r.codeHead, m.key)}>
                          {fmtMoney(r.months[j])}
                        </button>
                      ) : (
                        '-'
                      )}
                    </td>
                  ))}
                  <td className="num">
                    <button type="button" className="link-btn" onClick={() => open(r.codeHead, null)}>
                      <b>{fmtMoney(r.total)}</b>
                    </button>
                  </td>
                </tr>
              ))}
              {!rows.length && (
                <tr>
                  <td colSpan={columns.length} className="empty">
                    {loading ? 'Loading…' : `No payments – ${scope}.`}
                  </td>
                </tr>
              )}
            </tbody>
          )}
          {exportRows.length > 0 && (
            <tfoot>
              {statement ? (
                <tr>
                  <th colSpan={columns.length - 1}>Total</th>
                  <th className="num">{fmtMoney(sumPaid)}</th>
                </tr>
              ) : (
                <tr>
                  <th colSpan={2}>Total</th>
                  {months.map((m, j) => (
                    <th key={m.key} className="num">
                      {amt(monthTotals[j])}
                    </th>
                  ))}
                  <th className="num">{matrixFooter.total}</th>
                </tr>
              )}
            </tfoot>
          )}
        </table>
      </div>
      {cell && (
        <Modal title={`${headLabel(cell.codeHead)} – ${cellMonth || `FY ${fy}`}`} size="lg" onClose={() => setCell(null)}>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Sl.</th>
                  <th>Payment Date</th>
                  <th>Order No.</th>
                  <th>Supply Order / Contract No.</th>
                  <th>Firm / Vendor</th>
                  <th>Payment Ref.</th>
                  <th className="num">Amount (₹)</th>
                </tr>
              </thead>
              <tbody>
                {cellList.map((p, i) => (
                  <tr key={p._id}>
                    <td className="center">{i + 1}</td>
                    <td className="center">{fmtDate(p.paymentDate)}</td>
                    <td className="center">{p.orderNo}</td>
                    <td>{p.supplyOrderNo || '-'}</td>
                    <td>{p.projectOffice ? `${p.vendor} (${p.projectOffice})` : p.vendor}</td>
                    <td>{p.paymentRef || '-'}</td>
                    <td className="num">{fmtMoney(p.paymentAmount)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th colSpan={6}>Total</th>
                  <th className="num">{fmtMoney(round2(cellList.reduce((s, p) => s + p.paymentAmount, 0)))}</th>
                </tr>
              </tfoot>
            </table>
          </div>
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
            <button
              type="button"
              className="btn btn-blue"
              onClick={() => {
                set({ codeHead: cell.codeHead || NO_HEAD_VALUE, month: cell.month || '' });
                setCell(null);
              }}
            >
              Show as statement
            </button>
          </div>
        </Modal>
      )}
    </Panel>
  );
}

/** Orders: stand-alone record of purchases (GeM / other sources) — entry and its own report. */
export default function Orders() {
  const [tab, setTab] = useState('entry');
  const [editing, setEditing] = useState(null);
  // Shared by Order Report and Payments (MER): the FY and code head picked in one carry over to the other.
  const [link, setLink] = useState({ fy: '', codeHead: '', month: '' });
  return (
    <>
      <PageHeader icon={ShoppingCart} plainIcon title="Orders (GeM / Other Sources)" />
      <div className="tabs">
        <button type="button" className={`tab ${tab === 'entry' ? 'active' : ''}`} onClick={() => setTab('entry')}>
          <ClipboardList size={20} /> Order Entry
        </button>
        <button type="button" className={`tab ${tab === 'report' ? 'active' : ''}`} onClick={() => setTab('report')}>
          <BarChart3 size={20} /> Order Report
        </button>
        <button type="button" className={`tab ${tab === 'payments' ? 'active' : ''}`} onClick={() => setTab('payments')}>
          <IndianRupee size={20} /> Payments (MER)
        </button>
      </div>
      {tab === 'payments' ? (
        <PaymentReport link={link} setLink={setLink} onOpenOrders={() => setTab('report')} />
      ) : tab === 'entry' ? (
        <OrderForm
          key={editing?._id || 'new'}
          editing={editing}
          onSaved={() => {
            setEditing(null);
            setTab('report'); // the report reloads when it opens
          }}
          onCancelEdit={() => {
            setEditing(null);
            setTab('report');
          }}
          onLoad={(o) => setEditing(o)} // found via "Update Order": open it in the form
        />
      ) : (
        <OrderReport
          link={link}
          onLink={(fy, codeHead) => setLink((l) => ({ ...l, fy: fy || l.fy, codeHead, month: fy && fy !== l.fy ? '' : l.month }))}
          onPayments={(fy, codeHead) => {
            setLink((l) => ({ fy: fy || l.fy, codeHead, month: fy && fy !== l.fy ? '' : l.month }));
            setTab('payments');
          }}
          onEdit={(o) => {
            setEditing(o);
            setTab('entry');
          }}
        />
      )}
    </>
  );
}
