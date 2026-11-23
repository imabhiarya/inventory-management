import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  BarChart3, ClipboardList, List, Boxes, Download, Upload, RefreshCw, Bell, BookOpen, Handshake, Search, Printer, FileCheck, ShieldCheck,
} from 'lucide-react';
import AuditObservations from './Audit.jsx';
import { api } from '../api.js';
import { useApp } from '../context/AppContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { PageHeader, Panel, Field, Select, ExportButtons, DocHeader, OrientationSelect, usePrintOrientation } from '../components/ui.jsx';
import { fmtDate, fmtMoney, fmtQty, fyOptions, monthOptions, quarterOf, QUARTERS, fyStart, withOldNo, numberToWords, loanKindLabel } from '../utils/format.js';
import { printSection } from '../utils/export.js';

const REPORTS = [
  { key: 'mstb', label: 'MSTB – Main Store Board', icon: ClipboardList, period: 'monthly' },
  { key: 'qstb', label: 'QSTB – Quarterly Store Balance', icon: ClipboardList, period: 'quarterly' },
  { key: 'astb', label: 'ASTB – Annual Store Balance', icon: ClipboardList, period: 'yearly' },
  { key: 'bersvy', label: 'BER/SVY OFF – Item Life Report', icon: ClipboardList, noPeriod: true },
  { key: 'stock-statement', label: 'Stock Statement (Item-wise)', icon: Boxes },
  { key: 'receipt-register', label: 'Receipt Register', icon: Download },
  { key: 'issue-register', label: 'Issue Register', icon: Upload },
  { key: 'civ', label: 'Certified Issue Voucher (Monthly)', icon: FileCheck, period: 'monthly', monthlyOnly: true },
  { key: 'loan-register', label: 'Loan Store Register', icon: RefreshCw },
  { key: 'low-stock', label: 'Low Stock / Reorder Report', icon: Bell, noPeriod: true },
  { key: 'item-balance', label: 'Item-wise Balance Report', icon: BarChart3, noPeriod: true },
  { key: 'transactions', label: 'Ledger Transaction Report', icon: BookOpen },
];

const TILES = [
  { key: 'mstb', title: 'MSTB', sub: '(Main Store Board)', color: 'blue' },
  { key: 'qstb', title: 'QSTB', sub: '(Quarterly Store Balance)', color: 'green' },
  { key: 'astb', title: 'ASTB', sub: '(Annual Store Balance)', color: 'orange' },
  { key: 'bersvy', title: 'BER / SVY OFF', sub: '(BER / Survey Off Store Report)', color: 'purple' },
];

/** Time left until `limit` years, e.g. "2 yr 5 mth". */
function lifeLeft(ageValue, limit) {
  const m = Math.max(0, Math.round((limit - ageValue) * 12));
  return `${Math.floor(m / 12)} yr ${m % 12} mth`;
}

// BER / SVY OFF leaves out the Loan Store and Salvage ledgers.
const BER_EXCLUDED_LEDGERS = ['LOAN', 'SALVAGE'];

// BER / SVY OFF: life thresholds (years from the Receipt Voucher date).
const LIFE_OPTIONS = [5, 7, 10, 15].map((y) => ({ value: String(y), label: `${y} years and above` }));

/** Life bands (all stock held) and, when a life is chosen, how much is below / at or above it. */
function LifeSummary({ life }) {
  const { bands, threshold } = life;
  return (
    <div style={{ marginBottom: 14 }}>
      <h3 style={{ marginBottom: 6, color: 'var(--navy-800)' }}>Life Summary (as per RV date)</h3>
      {threshold && (
        <div className="row" style={{ gap: 10, marginBottom: 8 }}>
          <span className="badge badge-green" style={{ fontSize: 14, padding: '6px 12px' }}>
            Less than {threshold.years} years: {threshold.below.lots} line(s), Qty {fmtQty(threshold.below.qty)}
          </span>
          <span className="badge badge-red" style={{ fontSize: 14, padding: '6px 12px' }}>
            {threshold.years} years and above: {threshold.above.lots} line(s), Qty {fmtQty(threshold.above.qty)}
          </span>
        </div>
      )}
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Life</th>
              <th className="num">No. of Lines</th>
              <th className="num">Qty Held</th>
              <th>Item Names</th>
            </tr>
          </thead>
          <tbody>
            {bands.map((b) => (
              <tr key={b.key}>
                <td style={{ whiteSpace: 'nowrap' }}>{b.label}</td>
                <td className="num">{b.lots}</td>
                <td className="num">{fmtQty(b.qty)}</td>
                <td>{b.items.join(', ') || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {threshold && (
        <p style={{ margin: '10px 0 0' }}>
          <b>Items due for BER ({threshold.years} years and above):</b> {threshold.above.items.length ? threshold.above.items.join(', ') : 'None'}
        </p>
      )}
      <h3 style={{ margin: '14px 0 6px', color: 'var(--navy-800)' }}>Item-wise Life Detail (Ledger-wise)</h3>
    </div>
  );
}

const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); // m is 1-based

function rangeOf(p) {
  const y = Number(p.fy.slice(0, 4));
  if (p.period === 'monthly') {
    const [yy, mm] = p.month.split('-').map(Number);
    return { from: `${p.month}-01`, to: lastDay(yy, mm), label: `Month: ${monthOptions(p.fy).find((m) => m.value === p.month)?.label}` };
  }
  if (p.period === 'quarterly') {
    const n = Number(p.quarter.slice(1));
    const startMonth = 4 + (n - 1) * 3; // 1-based
    const sy = startMonth > 12 ? y + 1 : y;
    const sm = ((startMonth - 1) % 12) + 1;
    return {
      from: `${sy}-${String(sm).padStart(2, '0')}-01`,
      to: lastDay(sy, sm + 2),
      label: `${QUARTERS[n - 1].label}, FY ${p.fy}`,
    };
  }
  if (p.period === 'yearly') return { from: `${y}-04-01`, to: `${y + 1}-03-31`, label: `Financial Year ${p.fy}` };
  return { from: p.from, to: p.to, label: `${fmtDate(p.from)} to ${fmtDate(p.to)}` };
}

const sl = (rows) => ({ key: 'sl', label: 'Sl.', value: (r) => rows.indexOf(r) + 1 });
const qty = (key, label) => ({ key, label, align: 'right', numeric: true, format: fmtQty });
const money = (key, label) => ({ key, label, align: 'right', numeric: true, format: fmtMoney });

function balanceColumns(rows, ledgerLabel, { board = false } = {}) {
  return [
    sl(rows),
    { key: 'code', label: 'Item Code' },
    { key: 'name', label: 'Item Name', width: 30 },
    { key: 'ledger', label: 'Ledger', format: ledgerLabel, width: 20 },
    { key: 'uom', label: 'UoM' },
    qty('opening', 'Opening Bal Qty'),
    qty('receipt', 'Receipt Qty'),
    qty('issue', 'Issue Qty'),
    qty('closing', 'Closing Bal Qty'),
    // Stock taking boards: a blank Remarks column (filled in by hand) instead of the value.
    board ? { key: 'remarks', label: 'Remarks', value: () => '', width: 24 } : money('value', 'Value (₹)'),
  ];
}

// Stock taking board reports: printed in the board format, without values.
const BOARDS = ['mstb', 'qstb', 'astb'];

/** Printed heading of a stock taking board, worded by the chosen period. */
function boardTitle(p, range) {
  if (p.period === 'monthly') return `MONTHLY STOCK TAKING REPORT FOR THE MONTH OF ${range.label.replace('Month: ', '').toUpperCase()}`;
  if (p.period === 'quarterly') return `QUARTERLY STOCK TAKING REPORT FOR THE QUARTER ${range.label.toUpperCase()}`;
  if (p.period === 'yearly') return `ANNUAL STOCK TAKING REPORT FOR THE YEAR ${p.fy}`;
  return `STOCK TAKING REPORT FOR THE PERIOD ${fmtDate(range.from)} TO ${fmtDate(range.to)}`;
}

// `printHide` columns show on screen but are left out of the printout.
const cellClass = (c) => [c.align === 'right' ? 'num' : '', c.printHide ? 'no-print' : ''].filter(Boolean).join(' ');

function ReportTable({ columns, rows, footer, note }) {
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={cellClass(c)}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r._id || r.item || i}>
              {columns.map((c) => {
                const v = typeof c.value === 'function' ? c.value(r) : r[c.key];
                return (
                  <td key={c.key} className={cellClass(c)}>
                    {c.format ? c.format(v, r) : v}
                  </td>
                );
              })}
            </tr>
          ))}
          {note && rows.length > 0 && (
            <tr className="voucher-count">
              <td colSpan={columns.length}>{note}</td>
            </tr>
          )}
          {!rows.length && (
            <tr>
              <td colSpan={columns.length} className="empty">
                No records for the selected criteria.
              </td>
            </tr>
          )}
        </tbody>
        {footer && rows.length > 0 && (
          <tfoot>
            <tr>
              {columns.map((c) => (
                <td key={c.key} className={cellClass(c)}>
                  {footer[c.key] ?? ''}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

function LedgerSummaryTable({ summary, total, hideValueInPrint = false }) {
  const vc = hideValueInPrint ? 'num no-print' : 'num';
  return (
    <table className="data">
      <thead>
        <tr>
          <th>Sl.</th>
          <th>Store / Ledger</th>
          <th className="num">No. of Items</th>
          <th className="num">Opening Bal Qty</th>
          <th className="num">Receipt Qty</th>
          <th className="num">Issue Qty</th>
          <th className="num">Closing Bal Qty</th>
          <th className={vc}>Value (₹)</th>
        </tr>
      </thead>
      <tbody>
        {summary.map((s, i) => (
          <tr key={s.ledger}>
            <td className="center">{i + 1}</td>
            <td>{s.label}</td>
            <td className="num">{s.items}</td>
            <td className="num">{fmtQty(s.opening)}</td>
            <td className="num">{fmtQty(s.receipt)}</td>
            <td className="num">{fmtQty(s.issue)}</td>
            <td className="num">{fmtQty(s.closing)}</td>
            <td className={vc}>{fmtMoney(s.value)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <td colSpan={2} className="center">
            Total
          </td>
          <td className="num">{total.items}</td>
          <td className="num">{fmtQty(total.opening)}</td>
          <td className="num">{fmtQty(total.receipt)}</td>
          <td className="num">{fmtQty(total.issue)}</td>
          <td className="num">{fmtQty(total.closing)}</td>
          <td className={vc}>{fmtMoney(total.value)}</td>
        </tr>
      </tfoot>
    </table>
  );
}

/** Issue vouchers covered by a Certified Issue Voucher, the certificate and signature blocks. */
function CivCertificate({ civ, empty }) {
  if (empty) return <p className="muted" style={{ marginTop: 10 }}>Only issues saved with Issue Frequency “Monthly” appear on the Certified Issue Voucher.</p>;
  return (
    <div style={{ marginTop: 14 }}>
      <p style={{ fontSize: 14, marginTop: 14, lineHeight: 1.6 }}>
        Certified that the stores detailed above, issued{civ.unit ? ` to ${civ.unit}` : ''} during the month of <b>{civ.monthLabel}</b> vide
        the issue vouchers shown, have been received and actually consumed for bona fide government purposes, and that the quantities shown are
        correct.
      </p>
      <div className="doc-sign">
        <div>Issued By (Store Keeper)</div>
        <div>Officer In-Charge</div>
      </div>
    </div>
  );
}

/** Handing / Taking over of all stores with ledger-wise appendices. */
function HandingTaking() {
  const { meta, ledgerLabel, settings } = useApp();
  const toast = useToast();
  const [f, setF] = useState({ date: meta.today, fy: meta.currentFy, over: '', taking: '', type: 'all' });
  const [selected, setSelected] = useState(meta.ledgers.map((l) => l.key));
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [printKeys, setPrintKeys] = useState(null); // ledgers to include in the next print
  const [orientation, setOrientation] = usePrintOrientation();

  const load = async () => {
    setBusy(true);
    try {
      setData(await api.get('/reports/handing-taking', { date: f.date, fy: f.fy }));
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (printKeys) {
      printSection('ht-print', { orientation });
      setPrintKeys(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [printKeys]);

  const printAll = () => setPrintKeys({ summary: true, ledgers: f.type === 'appendix' ? selected : [] });
  const printOne = (key) => setPrintKeys({ summary: false, ledgers: [key] });
  const allChecked = selected.length === meta.ledgers.length;
  const sig = (
    <div className="doc-sign">
      <div>
        Handing Over By
        <br />
        {f.over}
      </div>
      <div>
        Taking Over By
        <br />
        {f.taking}
      </div>
    </div>
  );

  return (
    <Panel title="Handing Taking of All Store" icon={Handshake} bodyClass="panel-body">
      <div className="row" style={{ marginBottom: 12 }}>
        <b>Type of Report</b>
        <div className="radio-row">
          <label>
            <input type="radio" checked={f.type === 'all'} onChange={() => setF({ ...f, type: 'all' })} /> Handing Taking Report (All Store)
          </label>
          <label>
            <input type="radio" checked={f.type === 'appendix'} onChange={() => setF({ ...f, type: 'appendix' })} /> Appendix – Ledger Wise (Separate)
          </label>
        </div>
      </div>
      <div className="filters">
        <Field label="Handing Taking Date" required stack>
          <input className="input" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
        </Field>
        <Field label="Financial Year" stack>
          <Select value={f.fy} onChange={(v) => setF({ ...f, fy: v })} options={fyOptions(meta.currentFy)} />
        </Field>
        <div className="field stack grow">
          <label>Handing Over By</label>
          <input className="input" placeholder="Name, Rank & Appointment" value={f.over} onChange={(e) => setF({ ...f, over: e.target.value })} maxLength={120} />
        </div>
        <div className="field stack grow">
          <label>Taking Over By</label>
          <input className="input" placeholder="Name, Rank & Appointment" value={f.taking} onChange={(e) => setF({ ...f, taking: e.target.value })} maxLength={120} />
        </div>
        <button type="button" className="btn btn-blue" onClick={load} disabled={busy}>
          <Search size={18} /> Refresh
        </button>
      </div>
      {f.type === 'appendix' && (
        <div className="note" style={{ marginTop: 12, flexWrap: 'wrap' }}>
          <b>Select Store / Ledger for Appendix (Print Separate)</b>
          <label style={{ marginLeft: 'auto' }}>
            <input type="checkbox" checked={allChecked} onChange={() => setSelected(allChecked ? [] : meta.ledgers.map((l) => l.key))} /> Select All
          </label>
          <div className="check-row" style={{ width: '100%' }}>
            {meta.ledgers.map((l) => (
              <label key={l.key}>
                <input
                  type="checkbox"
                  checked={selected.includes(l.key)}
                  onChange={() => setSelected(selected.includes(l.key) ? selected.filter((k) => k !== l.key) : [...selected, l.key])}
                />
                {l.label}
              </label>
            ))}
          </div>
        </div>
      )}

      {data && (
        <div className="with-aside" style={{ marginTop: 14, gridTemplateColumns: 'minmax(0,1fr) 300px' }}>
          <div>
            <div className="panel-head" style={{ borderRadius: '8px 8px 0 0' }}>
              Ledger Summary (as on {fmtDate(data.to)})
            </div>
            <div className="table-wrap">
              <LedgerSummaryTable summary={data.summary} total={data.total} />
            </div>
          </div>
          <div className="ht-actions" style={{ display: 'grid', gap: 8, alignContent: 'start' }}>
            <label className="row" style={{ justifyContent: 'space-between', fontWeight: 600 }}>
              Page layout
              <OrientationSelect value={orientation} onChange={setOrientation} />
            </label>
            <button type="button" className="btn btn-green btn-lg" onClick={printAll}>
              <Printer size={20} /> Print Handing Taking {f.type === 'appendix' ? '+ Appendices' : '(All Store)'}
            </button>
            <div className="appx-label" style={{ textAlign: 'center', fontWeight: 600 }}>
              Print Appendix (Ledger Wise)
            </div>
            {meta.ledgers.map((l) => (
              <button key={l.key} type="button" className="btn btn-outline appx-btn" onClick={() => printOne(l.key)}>
                <Printer size={16} /> Print {l.label.replace(' Ledger', '')} Ledger Appendix
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Hidden printable document */}
      {data && (
        <div className="print-doc" id="ht-print">
          {(printKeys?.summary ?? true) && (
            <div>
              <DocHeader title="Handing / Taking Over Certificate – All Stores" subtitle={`As on ${fmtDate(data.to)} · Financial Year ${f.fy}`} />
              <p style={{ fontSize: 13 }}>
                Certified that the stores held on charge as detailed below have been handed over / taken over on {fmtDate(data.to)}, and the
                balances agree with the ledgers.
              </p>
              <LedgerSummaryTable summary={data.summary} total={data.total} />
              {sig}
            </div>
          )}
          {(printKeys?.ledgers || []).map((key, idx) => {
            const rows = data.rows.filter((r) => r.ledger === key);
            const label = ledgerLabel(key);
            return (
              <div key={key} className={printKeys.summary || idx > 0 ? 'page-break' : ''}>
                <div className="board-head">
                  <div className="board-appx">Appx</div>
                  <div className="board-title">HANDING TAKING REPORT : STORE</div>
                  <div className="civ-meta">
                    <div>UNIT: {settings.orgTitle}</div>
                    <div>Type of Ledger: {label}</div>
                    <div>Date: {fmtDate(data.to)}</div>
                  </div>
                </div>
                <ReportTable columns={balanceColumns(rows, ledgerLabel, { board: true }).filter((c) => c.key !== 'ledger')} rows={rows} />
                {sig}
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

export default function Reports() {
  const { meta, settings, ledgerLabel } = useApp();
  const toast = useToast();
  const [search] = useSearchParams();
  const initial = search.get('r');
  const [report, setReport] = useState(REPORTS.some((r) => r.key === initial) || ['handing-taking', 'audit'].includes(initial) ? initial : 'mstb');
  const [p, setP] = useState({
    fy: meta.currentFy,
    period: REPORTS.find((r) => r.key === initial)?.period || 'monthly',
    month: meta.today.slice(0, 7),
    quarter: quarterOf(meta.today),
    from: fyStart(meta.currentFy),
    to: meta.today,
  });
  const [ledger, setLedger] = useState('');
  const [unit, setUnit] = useState(''); // CIV: Issue To / Unit / Section (blank = all)
  const [civNo, setCivNo] = useState(''); // CIV: auto-filled with the covered Issue No(s). on Generate; editable
  const [asOn, setAsOn] = useState(meta.today);
  const [life, setLife] = useState('10'); // BER / SVY OFF: minimum life in years ('' = all)
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const cfg = REPORTS.find((r) => r.key === report);
  const months = useMemo(() => monthOptions(p.fy), [p.fy]);

  // Keep the month inside the chosen FY.
  useEffect(() => {
    if (!months.some((m) => m.value === p.month)) setP((s) => ({ ...s, month: months[0].value }));
  }, [months, p.month]);

  const choose = (key) => {
    setReport(key);
    setResult(null);
    const r = REPORTS.find((x) => x.key === key);
    if (r?.period) setP((s) => ({ ...s, period: r.period }));
  };

  const generate = async () => {
    setBusy(true);
    try {
      setResult(await build());
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  /** BER / SVY OFF: life of the stock still held, counted from its Receipt Voucher date. */
  async function buildItemLife() {
    const d = await api.get('/reports/item-life', { asOn, ledger: BER_EXCLUDED_LEDGERS.includes(ledger) ? '' : ledger, minYears: life });
    const rows = d.rows;
    const lifeLabel = LIFE_OPTIONS.find((o) => o.value === life)?.label || 'All items';
    return {
      title: `BER / Survey Off – Item Life Report${ledger ? ` – ${ledgerLabel(ledger)}` : ''}`,
      subtitle: `As on ${fmtDate(d.asOn)} · Life: ${lifeLabel}`,
      rows,
      note: `Total: ${rows.length} line(s) · ${numberToWords(rows.length)} Only`,
      life: { bands: d.bands, threshold: d.threshold },
      columns: [
        sl(rows),
        { key: 'code', label: 'Item Code', value: (r) => r.item.code },
        { key: 'item', label: 'Item Name', value: (r) => r.item.name, width: 28 },
        { key: 'ledger', label: 'Type of Ledger', format: ledgerLabel, width: 18 },
        { key: 'uom', label: 'A/U', value: (r) => r.item.uom },
        { key: 'rvNo', label: 'RV No.', value: (r) => withOldNo(r.rvNo, r) },
        { key: 'rvDate', label: 'RV Date', value: (r) => (r.rvDate ? fmtDate(r.rvDate) : '—') },
        { key: 'source', label: 'Source / From', width: 20 },
        qty('receivedQty', 'Qty Recd on RV'),
        qty('heldQty', 'Qty Held'),
        { key: 'life', label: 'Life', value: (r) => (r.ageYears == null ? '—' : `${r.ageYears} yr ${r.ageMonths} mth`) },
        ...(life
          ? [
              {
                key: 'status',
                label: 'Life Status',
                value: (r) => (r.due ? `Life over – BER due (${life}+ yrs)` : r.ageValue == null ? 'RV date not known' : `Within life (${lifeLeft(r.ageValue, Number(life))} left)`),
                width: 24,
              },
            ]
          : []),
        { key: 'remarks', label: 'Remarks', value: () => '', width: 22 },
      ],
    };
  }

  async function build() {
    if (report === 'bersvy') return buildItemLife();
    const range = rangeOf(p);
    if (!range.from || !range.to || range.from > range.to) throw new Error('Select a valid period');
    const period = range.label;
    const ledgerSuffix = ledger ? ` – ${ledgerLabel(ledger)}` : '';

    if (['mstb', 'qstb', 'astb', 'stock-statement'].includes(report)) {
      const d = await api.get('/reports/store-balance', { period: 'custom', from: range.from, to: range.to, ledger });
      const rows = d.rows;
      const titles = {
        mstb: 'MSTB – Main Store Board',
        qstb: 'QSTB – Quarterly Store Balance',
        astb: 'ASTB – Annual Store Balance',
        'stock-statement': 'Stock Statement (Item-wise)',
      };
      return {
        title: titles[report] + ledgerSuffix,
        subtitle: period,
        columns: balanceColumns(rows, ledgerLabel, { board: BOARDS.includes(report) }),
        rows,
        footer: BOARDS.includes(report) ? undefined : { name: 'Total', value: fmtMoney(d.total.value) },
        board: BOARDS.includes(report) ? { title: boardTitle(p, range) + ledgerSuffix.toUpperCase() } : null,
        summary: d.summary,
        total: d.total,
      };
    }
    if (report === 'receipt-register' || report === 'issue-register') {
      const isR = report === 'receipt-register';
      const d = await api.get(isR ? '/receipts' : '/issues', { from: range.from, to: range.to, status: 'POSTED', ledger, limit: 5000 });
      const rows = d.rows
        .slice()
        .reverse()
        .flatMap((v) => v.lines.map((l) => ({ ...l, v })));
      const total = rows.reduce((s, r) => s + r.amount, 0);
      return {
        title: (isR ? 'Receipt Register' : 'Issue Register') + ledgerSuffix,
        subtitle: period,
        rows,
        footer: { item: 'Total', amount: fmtMoney(total) },
        columns: [
          sl(rows),
          { key: 'no', label: isR ? 'Receipt No.' : 'Issue No.', value: (r) => (isR ? r.v.receiptNo : r.v.issueNo) },
          isR
            ? { key: 'oldRvNo', label: 'Old RV No.', value: (r) => r.v.oldRvNo || '' }
            : { key: 'oldIvNo', label: 'Old IV No.', value: (r) => r.v.oldIvNo || '' },
          { key: 'date', label: 'Date', value: (r) => fmtDate(r.v.date) },
          { key: 'ledger', label: 'Type of Store / Ledger', value: (r) => ledgerLabel(r.v.ledger), width: 22 },
          { key: 'type', label: 'Type', value: (r) => (isR ? r.v.receiptType : r.v.issueType) },
          { key: 'party', label: isR ? 'Source / From' : 'Issued To', value: (r) => (isR ? r.v.source : r.v.issueTo), width: 26 },
          { key: 'ref', label: isR ? 'PO / Sanction No.' : 'Authority / Ref.', value: (r) => (isR ? r.v.poNo : r.v.authorityRef) },
          ...(isR ? [{ key: 'poDate', label: 'PO / Sanction Date', value: (r) => (r.v.poDate ? fmtDate(r.v.poDate) : '—') }] : []),
          { key: 'item', label: 'Item', value: (r) => `${r.item?.name} (${r.item?.code})`, width: 30 },
          { key: 'uom', label: 'UoM', value: (r) => r.item?.uom },
          qty('qty', 'Qty'),
          money('rate', 'Rate (₹)'),
          money('amount', 'Amount (₹)'),
        ],
      };
    }
    if (report === 'civ') {
      const d = await api.get('/reports/civ', { month: p.month, ledger, issueTo: unit.trim() });
      const rows = d.rows;
      // CIV No. = Issue No. of the monthly issue voucher(s) it covers, with its Old IV No. when entered (still editable).
      setCivNo(d.issues.map((v) => withOldNo(v.issueNo, v)).join(', '));
      const monthLabel = months.find((m) => m.value === p.month)?.label || p.month;
      return {
        title: `Certified Issue Voucher${ledgerSuffix}`,
        subtitle: `Month: ${monthLabel}${unit.trim() ? ` · Issued to ${unit.trim()}` : ''}`,
        rows,
        note: `Total Items: ${rows.length} (${numberToWords(rows.length)} Only)`,
        columns: [
          sl(rows),
          { key: 'code', label: 'Item Code', value: (r) => r.item?.code },
          { key: 'item', label: 'Item Name', value: (r) => r.item?.name, width: 30 },
          ...(ledger ? [] : [{ key: 'ledger', label: 'Ledger', format: ledgerLabel, width: 20 }]),
          { key: 'uom', label: 'UoM', value: (r) => r.item?.uom },
          qty('qty', 'Qty Issued'),
          { key: 'ledgerPages', label: 'Ledger Pg' },
          { key: 'issueNos', label: 'Issue Vouchers', width: 30 },
        ],
        civ: {
          monthLabel,
          unit: unit.trim() || (d.units.length === 1 ? d.units[0] : ''),
          ledger: ledger ? ledgerLabel(ledger) : 'All Ledgers',
        },
      };
    }
    if (report === 'loan-register') {
      const d = await api.get('/loans', { from: range.from, to: range.to, status: 'POSTED', limit: 5000 });
      const rows = d.rows
        .slice()
        .reverse()
        .flatMap((v) => v.lines.map((l) => ({ ...l, v })));
      return {
        title: 'Loan Store Register',
        subtitle: period,
        rows,
        columns: [
          sl(rows),
          { key: 'no', label: 'Voucher No.', value: (r) => r.v.voucherNo },
          { key: 'date', label: 'Date', value: (r) => fmtDate(r.v.date) },
          { key: 'kind', label: 'Transaction', value: (r) => loanKindLabel(r.v.kind) },
          { key: 'to', label: 'Issue To / Received From', value: (r) => r.v.issueTo, width: 26 },
          { key: 'item', label: 'Item', value: (r) => `${r.item?.name} (${r.item?.code})`, width: 28 },
          qty('qty', 'Qty'),
          { key: 'returnedQty', label: 'Returned', align: 'right', value: (r) => (r.v.kind === 'ISSUE' ? fmtQty(r.returnedQty) : '') },
          { key: 'due', label: 'Due Date', value: (r) => (r.v.kind === 'ISSUE' ? fmtDate(r.v.returnDueDate) : '') },
          {
            key: 'status',
            label: 'Status',
            value: (r) =>
              r.v.kind === 'ISSUE' ? { ISSUED: 'Issued', PARTIAL: 'Part Returned', RETURNED: 'Returned' }[r.v.returnStatus] : 'Received',
          },
        ],
      };
    }
    if (report === 'low-stock') {
      const d = await api.get('/reports/low-stock', { ledger });
      const rows = d.rows;
      return {
        title: `Low Stock / Re-order Report${ledgerSuffix}`,
        subtitle: `As on ${fmtDate(meta.today)}`,
        rows,
        columns: [
          sl(rows),
          { key: 'code', label: 'Item Code' },
          { key: 'name', label: 'Item Name', width: 30 },
          { key: 'ledger', label: 'Ledger', format: ledgerLabel, width: 20 },
          { key: 'uom', label: 'UoM' },
          qty('currentStock', 'Balance Qty'),
          qty('minStock', 'Min Stock'),
          qty('shortfall', 'Shortfall'),
        ],
      };
    }
    if (report === 'item-balance') {
      const d = await api.get('/reports/stock-statement', { asOn, ledger });
      const rows = d.rows;
      return {
        title: `Item-wise Balance Report${ledgerSuffix}`,
        subtitle: `As on ${fmtDate(asOn)}`,
        rows,
        footer: { name: 'Total', value: fmtMoney(d.total.value) },
        columns: [
          sl(rows),
          { key: 'code', label: 'Item Code' },
          { key: 'name', label: 'Item Name', width: 30 },
          { key: 'ledger', label: 'Ledger', format: ledgerLabel, width: 20 },
          { key: 'uom', label: 'UoM' },
          qty('closing', 'Balance Qty'),
          qty('minStock', 'Min Stock'),
          money('avgRate', 'Avg Rate (₹)'),
          money('value', 'Value (₹)'),
        ],
      };
    }
    if (report === 'transactions') {
      const d = await api.get('/reports/transactions', { from: range.from, to: range.to, ledger });
      const rows = d.rows;
      return {
        title: `Ledger Transaction Report${ledgerSuffix}`,
        subtitle: period,
        rows,
        columns: [
          sl(rows),
          { key: 'date', label: 'Date', format: fmtDate },
          { key: 'voucherTypeLabel', label: 'Vouch. Type' },
          { key: 'voucherNo', label: 'Vouch. No.', value: (r) => withOldNo(r.voucherNo, r) },
          { key: 'ledger', label: 'Ledger', format: ledgerLabel, width: 20 },
          { key: 'item', label: 'Item', value: (r) => `${r.item?.name} (${r.item?.code})`, width: 30 },
          { key: 'uom', label: 'UoM', value: (r) => r.item?.uom },
          { key: 'receiptQty', label: 'Receipt Qty', align: 'right', numeric: true, format: (v) => (v ? fmtQty(v) : '-') },
          { key: 'issueQty', label: 'Issue Qty', align: 'right', numeric: true, format: (v) => (v ? fmtQty(v) : '-') },
          money('value', 'Value (₹)'),
          { key: 'remarks', label: 'Remarks', width: 30 },
        ],
      };
    }
    throw new Error('Unknown report');
  }

  const isHT = report === 'handing-taking';
  const isAudit = report === 'audit';

  return (
    <>
      <PageHeader icon={BarChart3} plainIcon title="Reports" />
      <div className="tiles four" style={{ marginBottom: 14 }}>
        {TILES.map((t) => (
          <button key={t.key} type="button" className={`tile ${t.color} ${report === t.key ? 'selected' : ''}`} style={{ minHeight: 120, fontSize: 26, gap: 4 }} onClick={() => choose(t.key)}>
            <ClipboardList size={42} style={{ width: 42, height: 42 }} />
            {t.title}
            <small style={{ fontSize: 15, fontWeight: 600 }}>{t.sub}</small>
          </button>
        ))}
      </div>

      {!isHT && !isAudit && (
        <Panel bodyClass="panel-body">
          <div className="filters">
            <b style={{ fontSize: 18, color: 'var(--navy-800)', alignSelf: 'center' }}>Report Period</b>
            {cfg?.noPeriod ? (
              <>
                {(report === 'item-balance' || report === 'bersvy') && (
                  <Field label="As on Date" stack>
                    <input className="input" type="date" value={asOn} max={meta.today} onChange={(e) => setAsOn(e.target.value)} />
                  </Field>
                )}
                {report === 'bersvy' && (
                  <Field label="Life (as per RV date)" stack>
                    <Select value={life} onChange={setLife} placeholder="All items (any life)" options={LIFE_OPTIONS} />
                  </Field>
                )}
              </>
            ) : (
              <>
                <Field label="Financial Year" required stack>
                  <Select value={p.fy} onChange={(v) => setP({ ...p, fy: v })} options={fyOptions(meta.currentFy)} />
                </Field>
                <div className="radio-row" style={{ alignSelf: 'center', display: cfg?.monthlyOnly ? 'none' : undefined }}>
                  {[
                    ['monthly', 'Monthly'],
                    ['quarterly', 'Quarterly'],
                    ['yearly', 'Yearly (FY)'],
                    ['custom', 'Custom'],
                  ].map(([v, l]) => (
                    <label key={v}>
                      <input type="radio" name="period" checked={p.period === v} onChange={() => setP({ ...p, period: v })} /> {l}
                    </label>
                  ))}
                </div>
                {p.period === 'monthly' && (
                  <Field label="Month" stack>
                    <Select value={p.month} onChange={(v) => setP({ ...p, month: v })} options={months} />
                  </Field>
                )}
                {p.period === 'quarterly' && (
                  <Field label="Quarter" stack>
                    <Select value={p.quarter} onChange={(v) => setP({ ...p, quarter: v })} options={QUARTERS} />
                  </Field>
                )}
                {p.period === 'custom' && (
                  <>
                    <Field label="From" stack>
                      <input className="input" type="date" value={p.from} onChange={(e) => setP({ ...p, from: e.target.value })} />
                    </Field>
                    <Field label="To" stack>
                      <input className="input" type="date" value={p.to} onChange={(e) => setP({ ...p, to: e.target.value })} />
                    </Field>
                  </>
                )}
              </>
            )}
            {report === 'civ' && (
              <Field label="CIV No." stack>
                <input className="input" value={civNo} onChange={(e) => setCivNo(e.target.value)} placeholder="Auto from Issue No." maxLength={300} style={{ width: 240 }} title="Filled with the Issue No. and Old IV No. of the monthly issue voucher(s) when you generate the report" />
              </Field>
            )}
            {report === 'civ' && (
              <Field label="Issue To / Unit" stack>
                <input className="input" list="civ-units" value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="All Units" maxLength={160} />
                <datalist id="civ-units">
                  {settings.units.map((s) => (
                    <option key={s} value={s} />
                  ))}
                </datalist>
              </Field>
            )}
            <Field label={report === 'bersvy' ? 'Type of Ledger' : 'Ledger'} stack>
              <Select
                value={report === 'bersvy' && BER_EXCLUDED_LEDGERS.includes(ledger) ? '' : ledger}
                onChange={setLedger}
                placeholder="All Ledgers"
                options={meta.ledgers
                  .filter((l) => report !== 'bersvy' || !BER_EXCLUDED_LEDGERS.includes(l.key))
                  .map((l) => ({ value: l.key, label: l.label }))}
              />
            </Field>
            <span className="spacer" />
            <button type="button" className="btn btn-blue btn-lg" onClick={generate} disabled={busy}>
              <Search size={20} /> {busy ? 'Generating…' : 'Generate Report'}
            </button>
          </div>
        </Panel>
      )}

      <div className="with-aside" style={{ gridTemplateColumns: '300px minmax(0,1fr)' }}>
        <Panel title="Report List" icon={List} bodyClass="" className="report-list">
          <ul className="link-list" style={{ padding: '0 8px' }}>
            {REPORTS.map(({ key, label, icon: Icon }) => (
              <li key={key}>
                <button type="button" className={report === key ? 'active' : ''} onClick={() => choose(key)} style={{ fontSize: 15 }}>
                  <Icon size={18} /> {label}
                </button>
              </li>
            ))}
            <li>
              <button
                type="button"
                className={`ht ${isHT ? 'active' : ''}`}
                onClick={() => choose('handing-taking')}
                style={{ fontSize: 16, fontWeight: 800 }}
              >
                <Handshake size={20} /> Handing Taking of All Store
              </button>
            </li>
            <li>
              <button type="button" className={`audit-tab ${isAudit ? 'active' : ''}`} onClick={() => choose('audit')} style={{ fontSize: 16, fontWeight: 800 }}>
                <ShieldCheck size={20} /> Audit Observations
              </button>
            </li>
          </ul>
        </Panel>

        <div>
          {isAudit ? (
            <AuditObservations />
          ) : isHT ? (
            <HandingTaking />
          ) : (
            <Panel
              title={result ? result.title : cfg?.label}
              icon={ClipboardList}
              id="report-print"
              className={result?.board || result?.civ ? 'board-report' : ''}
              right={result && <span>{result.subtitle}</span>}
            >
              {!result ? (
                <p className="muted">Choose the period and click Generate Report.</p>
              ) : (
                <>
                  {result.civ ? (
                    // Certified Issue Voucher heading (shown on screen and printed).
                    <div className="civ-head">
                      <div className="civ-form-no">In lieu of IAFZ- 2096 (Revised)</div>
                      <div className="civ-title">CERTIFIED ISSUE VOUCHER</div>
                      <div className="civ-meta">
                        <div>Unit:- {settings.orgTitle}</div>
                        <div>Month:- {result.civ.monthLabel}</div>
                        <div>CIV No: {civNo.trim() || '____________'}</div>
                        <div>Date: {fmtDate(meta.today)}</div>
                        <div>Ledger:- {result.civ.ledger}</div>
                        <div />
                        <div>Issue To:- {result.civ.unit || 'All Units'}</div>
                      </div>
                    </div>
                  ) : result.board ? (
                    <div className="print-doc board-head">
                      <div className="board-appx">Appx</div>
                      <div className="board-title">{result.board.title}</div>
                      <div className="board-unit">UNIT:- {settings.orgTitle}</div>
                    </div>
                  ) : (
                    <div className="print-doc">
                      <DocHeader title={result.title} subtitle={`${result.subtitle} · ${settings.storeName}, ${settings.station}`} />
                    </div>
                  )}
                  {result.summary && (
                    <div style={{ marginBottom: 14 }}>
                      <h3 style={{ marginBottom: 6, color: 'var(--navy-800)' }}>Ledger Summary</h3>
                      <div className="table-wrap">
                        <LedgerSummaryTable summary={result.summary.filter((s) => s.items)} total={result.total} hideValueInPrint={!!result.board} />
                      </div>
                      <h3 style={{ margin: '14px 0 6px', color: 'var(--navy-800)' }}>Item-wise Detail</h3>
                    </div>
                  )}
                  {result.life && <LifeSummary life={result.life} />}
                  <ReportTable columns={result.columns} rows={result.rows} footer={result.footer} note={result.note} />
                  {result.civ && <CivCertificate civ={result.civ} empty={!result.rows.length} />}
                  {result.board && <div className="print-doc board-sign">P.O ____________________</div>}
                  <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
                    <ExportButtons
                      orientable
                      printId="report-print"
                      disabled={!result.rows.length}
                      getExport={() => ({
                        title: result.title,
                        subtitle: `${result.subtitle} · ${settings.storeName}`,
                        columns: result.columns,
                        rows: result.rows,
                        footer: result.footer,
                        filename: result.title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
                      })}
                    />
                  </div>
                </>
              )}
            </Panel>
          )}
        </div>
      </div>
    </>
  );
}
