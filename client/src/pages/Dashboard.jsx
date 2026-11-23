import { Link, useNavigate, useOutletContext } from 'react-router-dom';
import {
  LayoutGrid, PackagePlus, PackageOpen, PackageMinus, RefreshCw, BookOpen, FileBarChart, Store, BarChart3,
  CalendarDays, ChevronRight, Database, Download, Upload, Monitor, AlertTriangle,
} from 'lucide-react';
import { useApp } from '../context/AppContext.jsx';
import { useFetch } from '../hooks.js';
import { PageHeader, Panel } from '../components/ui.jsx';
import { fmtQty } from '../utils/format.js';

const TILES = [
  { to: '/items', label: 'New Stock Entry', sub: 'Register new items', icon: PackagePlus, color: 'blue' },
  { to: '/receipt', label: 'Receipt', sub: 'Goods received into store', icon: PackageOpen, color: 'green' },
  { to: '/issue', label: 'Issue', sub: 'Goods issued from store', icon: PackageMinus, color: 'orange' },
  { to: '/loan', label: 'Loan Store', sub: 'Loan issue & return', icon: RefreshCw, color: 'purple' },
  { to: '/ledger', label: 'Master Ledger', sub: 'Item-wise register', icon: BookOpen, color: 'sky' },
  { to: '/reports', label: 'Reports', sub: 'MSTB · QSTB · ASTB & more', icon: FileBarChart, color: 'violet' },
];

export default function Dashboard() {
  const { settings, meta, isAdmin, ledgerLabel } = useApp();
  const { online } = useOutletContext();
  const { data } = useFetch('/dashboard');
  const navigate = useNavigate();
  const c = data?.counts;

  return (
    <>
      <PageHeader
        icon={LayoutGrid}
        plainIcon
        title="Dashboard"
        back={false}
        extra={
          <span className={`pill ${online ? 'online' : 'offline'}`}>
            <Monitor size={18} /> {online ? 'Online' : 'Offline'}
          </span>
        }
      />
      <div className="with-aside">
        <div>
          <div className="tiles dash-tiles">
            {TILES.map(({ to, label, sub, icon: Icon, color }, i) => (
              <Link key={to} to={to} className={`tile ${color}`} style={{ '--i': i }}>
                <Icon className="dt-bg" strokeWidth={1.2} aria-hidden="true" />
                <span className="dt-bubbles" aria-hidden="true" />
                <span className="dt-ico">
                  <Icon strokeWidth={1.9} />
                </span>
                <span className="dt-label">{label}</span>
                <span className="dt-sub">{sub}</span>
              </Link>
            ))}
          </div>
          {c && (
            <div className="kpis">
              <div className="kpi">
                <div className="v">{c.activeItems}</div>
                <div className="l">Active items</div>
              </div>
              <div className={`kpi ${c.lowStock ? 'warn' : ''}`}>
                <div className="v">{c.lowStock}</div>
                <div className="l">At / below re-order level</div>
              </div>
              <div className="kpi">
                <div className="v">
                  {c.receiptsMonth} / {c.issuesMonth}
                </div>
                <div className="l">Receipts / Issues this month</div>
              </div>
              <div className={`kpi ${c.loansOverdue ? 'warn' : ''}`}>
                <div className="v">{c.loansOut}</div>
                <div className="l">Loans outstanding{c.loansOverdue ? ` (${c.loansOverdue} overdue)` : ''}</div>
              </div>
            </div>
          )}
          {data?.lowStock?.length > 0 && (
            <Panel title="Low Stock / Re-order Alert" icon={AlertTriangle} bodyClass="table-wrap" right={<Link to="/reports?r=low-stock" style={{ color: '#fff' }}>View all</Link>}>
              <table className="data">
                <thead>
                  <tr>
                    <th>Item Code</th>
                    <th>Item Name</th>
                    <th>Ledger</th>
                    <th className="num">Balance</th>
                    <th className="num">Min Stock</th>
                  </tr>
                </thead>
                <tbody>
                  {data.lowStock.map((i) => (
                    <tr key={i._id}>
                      <td className="center">{i.code}</td>
                      <td>{i.name}</td>
                      <td>{ledgerLabel(i.ledger)}</td>
                      <td className="num error-text">
                        {fmtQty(i.currentStock)} {i.uom}
                      </td>
                      <td className="num">{fmtQty(i.minStock)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          )}
        </div>
        <div>
          <Panel title="Store Details" icon={Store} className="dash-card store">
            <dl className="kv">
              <dt>Store Name</dt>
              <span>:</span>
              <dd>{settings.storeName}</dd>
              <dt>Station / Unit</dt>
              <span>:</span>
              <dd>{settings.station}</dd>
              <dt>Store In-Charge</dt>
              <span>:</span>
              <dd>{settings.storeInCharge}</dd>
              <dt>Financial Year</dt>
              <span>:</span>
              <dd>{meta.currentFy.replace('-', ' - ')}</dd>
            </dl>
          </Panel>
          <Panel title="Reports – Stock Taking" icon={BarChart3} className="dash-card reports">
            <ul className="link-list">
              {[
                ['Monthly Stock Taking', 'mstb'],
                ['Quarterly Stock Taking', 'qstb'],
                ['Annual Stock Taking', 'astb'],
              ].map(([label, r]) => (
                <li key={r} className={r}>
                  <button type="button" onClick={() => navigate(`/reports?r=${r}`)}>
                    <CalendarDays size={20} /> {label} <ChevronRight className="chev" size={20} />
                  </button>
                </li>
              ))}
            </ul>
          </Panel>
          {isAdmin && (
            <Panel title="Data Backup" icon={Database} className="dash-card backup">
              <div style={{ display: 'grid', gap: 10 }}>
                <a className="btn btn-blue btn-lg dash-backup-btn" href="/api/backup" download>
                  <Download size={20} /> Backup (JSON)
                </a>
                <Link className="btn btn-outline btn-lg dash-restore-btn" to="/backup">
                  <Upload size={20} /> Restore
                </Link>
              </div>
            </Panel>
          )}
        </div>
      </div>
    </>
  );
}
