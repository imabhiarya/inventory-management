import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  Home, CalendarDays, Clock3, PlusSquare, ShoppingCart, ClipboardPen, Download, Upload, RefreshCw, BookOpen, BarChart3, Settings, Database, LogOut, KeyRound, Menu, Boxes,
} from 'lucide-react';
import { useApp } from '../context/AppContext.jsx';
import ChangePasswordModal from './ChangePasswordModal.jsx';
import IndianFlag from './IndianFlag.jsx';

/** Credit line shown small in the footer of every page, including the login page. */
export const DESIGNED_BY = 'Designed by Nb Sub/SKT Saroj Kumar';

export const NAV = [
  // `color` / `color2`: the item's own colours in the sidebar (icon, hover and active gradient).
  { to: '/', label: 'Dashboard', icon: Home, end: true, color: '#4fa8ff', color2: '#1565d8' },
  { to: '/items', label: 'New Stock Entry', icon: PlusSquare, color: '#38d9f5', color2: '#0b8fb3' },
  { to: '/receipt', label: 'Receipt', icon: Download, color: '#5fe07c', color2: '#1b8a2e' },
  { to: '/issue', label: 'Issue', icon: Upload, color: '#ffa94d', color2: '#e8590c' },
  { to: '/loan', label: 'Loan Store', icon: RefreshCw, color: '#c886ff', color2: '#7b2fd0' },
  { to: '/ledger', label: 'Master Ledger', icon: BookOpen, color: '#4fe3c1', color2: '#0f8f7a' },
  { to: '/reports', label: 'Reports', icon: BarChart3, color: '#ff7eb6', color2: '#c2255c' },
  // Stand-alone purchase order record (GeM / other sources) with its own Order Report.
  { to: '/orders', label: 'Orders', icon: ShoppingCart, color: '#74c0fc', color2: '#1971c2' },
  // Demand (indent) for items of any ledger, printed as a demand form.
  { to: '/demand', label: 'Demand', icon: ClipboardPen, color: '#b2f2bb', color2: '#2b8a3e' },
  { to: '/settings', label: 'Settings', icon: Settings, color: '#ffd43b', color2: '#d99a10' },
  { to: '/backup', label: 'Backup & Restore', icon: Database, admin: true, color: '#ff8787', color2: '#c92a2a' },
];

/** Live date and time, shown on the right of the header. */
function HeaderClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const date = now.toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'short', year: 'numeric' });
  const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
  return (
    <div className="org-clock" aria-label={`${date}, ${time}`}>
      <div className="org-clock-row date">
        <CalendarDays size={16} /> {date}
      </div>
      <div className="org-clock-row time">
        <Clock3 size={18} className="org-clock-ico" /> {time.toUpperCase()}
      </div>
    </div>
  );
}

export function AppHeader({ onMenu }) {
  const { settings } = useApp() || {};
  return (
    <header className="app-header">
      {onMenu ? (
        <button type="button" className="menu-toggle" onClick={onMenu} aria-label="Open menu">
          <Menu size={22} />
        </button>
      ) : null}
      <span className="emblem-wrap left">
        <img className="logo left emblem" src="/logo-left.png" alt="Corps of Engineers emblem" />
      </span>
      <div className="titles">
        {/* Office name and motto, with a waving national flag on each side. */}
        <div className="org-center">
          <IndianFlag side="left" />
          <div className="org-main">
            <div className="org-title">{settings?.orgTitle || 'HQ CWE SHILLONG'}</div>
            <div className="org-sub">{settings?.orgSubtitle || 'STORE INVENTORY MANAGEMENT SYSTEM'}</div>
          </div>
          <IndianFlag side="right" />
        </div>
        {/* System name in small colourful letters, unless the subtitle already says it. */}
        {settings?.orgSubtitle && !/store inventory management system/i.test(settings.orgSubtitle) && (
          <div className="org-sys">
            STORE INVENTORY <br className="org-sys-br" />
            MANAGEMENT SYSTEM
          </div>
        )}
        {settings && <HeaderClock />}
      </div>
      <span className="emblem-wrap right">
        <img className="logo emblem" src="/logo-right.png" alt="Military Engineer Services emblem" />
      </span>
    </header>
  );
}

/** Whether the app's own server and database (on this PC) answer. Nothing to do with the internet. */
function useServerStatus() {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    let alive = true;
    const check = () =>
      fetch('/api/health')
        .then((r) => alive && setOnline(r.ok))
        .catch(() => alive && setOnline(false));
    check();
    const t = setInterval(check, 30000);
    window.addEventListener('online', check);
    window.addEventListener('offline', check);
    return () => {
      alive = false;
      clearInterval(t);
      window.removeEventListener('online', check);
      window.removeEventListener('offline', check);
    };
  }, []);
  return online;
}

export default function Layout() {
  const { user, logout, isAdmin, settings } = useApp();
  const [open, setOpen] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const online = useServerStatus();
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname]);

  return (
    <>
      <AppHeader onMenu={() => setOpen((o) => !o)} />
      <div className="shell">
        <aside className={`sidebar ${open ? 'open' : ''}`}>
          <nav>
            {NAV.filter((n) => !n.admin || isAdmin).map(({ to, label, icon: Icon, end, color, color2 }, i) => (
              <NavLink key={to} to={to} end={end} style={{ '--i': i, '--c': color, '--c2': color2 }}>
                <Icon size={24} className="nav-ico" /> <span>{label}</span>
              </NavLink>
            ))}
          </nav>
          {/* Signed-in user card with a slowly rotating rainbow border. */}
          <div className="user-box">
            <div className="user-card">
              <div className="user-top">
                <span className="user-avatar" aria-hidden="true">
                  {(user.name || user.username || '?')
                    .split(/\s+/)
                    .filter(Boolean)
                    .slice(0, 2)
                    .map((w) => w[0].toUpperCase())
                    .join('')}
                  <i className="user-online" />
                </span>
                <div className="user-meta">
                  <small>Signed in as</small>
                  <strong title={user.name}>{user.name}</strong>
                  <span className={`user-role ${user.role}`}>{user.role}</span>
                </div>
              </div>
              <div className="row">
                <button type="button" className="pw" onClick={() => setPwOpen(true)}>
                  <KeyRound size={14} /> Password
                </button>
                <button type="button" className="out" onClick={logout}>
                  <LogOut size={14} /> Sign out
                </button>
              </div>
            </div>
          </div>
        </aside>
        <main className="main">
          <div className="main-content">
            <Outlet context={{ online }} />
          </div>
          <footer className="app-footer">
            <span>
              <Boxes size={20} /> {settings?.orgTitle} – {settings?.orgSubtitle}
            </span>
            <span className="sep" />
            <span className="credit">{DESIGNED_BY}</span>
            <span className="sep" />
            <span>
              <Database size={18} /> {online ? 'Database on this PC: Connected (works offline)' : 'Database on this PC: not running'}
            </span>
            <span>Version 1.0</span>
          </footer>
        </main>
      </div>
      {pwOpen && <ChangePasswordModal onClose={() => setPwOpen(false)} />}
    </>
  );
}
