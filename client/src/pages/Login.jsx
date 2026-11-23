import { useEffect, useState } from 'react';
import {
  User,
  Lock,
  Eye,
  EyeOff,
  LogIn,
  Loader2,
  AlertCircle,
  Info,
  ShieldCheck,
  Wifi,
  Database,
  ClipboardCheck,
  Boxes,
  ChartNoAxesColumnIncreasing,
} from 'lucide-react';
import { useApp } from '../context/AppContext.jsx';
import { DESIGNED_BY } from '../components/Layout.jsx';
import IndianFlag from '../components/IndianFlag.jsx';

const FEATURES = [
  { icon: ClipboardCheck, label: 'Stock Control' },
  { icon: Boxes, label: 'Issue & Receipt' },
  { icon: ChartNoAxesColumnIncreasing, label: 'Reports' },
];

const BADGES = [
  { icon: ShieldCheck, label: 'Secure Login' },
  { icon: Wifi, label: 'Offline Ready' },
  { icon: Database, label: 'Data Backup' },
];

// "Remember Me" keeps only the username on this computer; the session itself is the server cookie.
const REMEMBER_KEY = 'mes-login-username';
const readRemembered = () => {
  try {
    return localStorage.getItem(REMEMBER_KEY) || '';
  } catch {
    return '';
  }
};
const writeRemembered = (name) => {
  try {
    if (name) localStorage.setItem(REMEMBER_KEY, name);
    else localStorage.removeItem(REMEMBER_KEY);
  } catch {
    /* storage unavailable: nothing to remember */
  }
};

/** Faded store-room picture behind the login form: a rack of boxes and a stock register clipboard. */
function CardScene() {
  const box = (x, y, w, h, gold) => (
    <g className={`cs-box${gold ? ' gold' : ''}`} key={`${x}-${y}`}>
      <rect x={x} y={y} width={w} height={h} rx="2" />
      <line x1={x + w / 2} y1={y} x2={x + w / 2} y2={y + h * 0.35} />
    </g>
  );
  return (
    <svg className="lw-card-scene" viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      {/* rack */}
      <g className="cs-rack">
        <line x1="190" y1="20" x2="190" y2="290" />
        <line x1="390" y1="20" x2="390" y2="290" />
        {[95, 185, 275].map((y) => (
          <line key={y} x1="184" y1={y} x2="396" y2={y} />
        ))}
      </g>
      {box(200, 55, 50, 40)}
      {box(256, 65, 38, 30, true)}
      {box(300, 45, 60, 50)}
      {box(205, 140, 60, 45, true)}
      {box(272, 150, 44, 35)}
      {box(322, 135, 56, 50)}
      {box(198, 230, 70, 45)}
      {box(276, 240, 40, 35, true)}
      {box(322, 225, 60, 50)}
      {/* clipboard with stock register */}
      <g className="cs-clip">
        <rect x="20" y="50" width="130" height="180" rx="10" />
        <rect x="60" y="40" width="50" height="20" rx="5" />
        {[90, 125, 160, 195].map((y) => (
          <g key={y}>
            <polyline points={`38,${y} 45,${y + 7} 58,${y - 6}`} />
            <line x1="70" y1={y} x2="132" y2={y} />
          </g>
        ))}
      </g>
    </svg>
  );
}

/**
 * Background picture for the white area: a store / warehouse — storage racks loaded with boxes and a
 * forklift carrying a box (drawn here, so no image file is needed; faded so the text stays readable).
 */
function WarehouseScene() {
  const box = (x, y, w, h, gold) => (
    <g key={`${x}-${y}`}>
      <rect x={x} y={y} width={w} height={h} rx="2" className={gold ? 'ws-box gold' : 'ws-box'} />
      <path d={`M${x + w / 2 - 6} ${y} V${y + h * 0.35} H${x + w / 2 + 6} V${y}`} className="ws-tape" />
    </g>
  );
  // Two racks of three shelves; boxes of a few sizes on each shelf.
  const rack = (x) => (
    <g key={x}>
      <rect x={x} y="60" width="8" height="250" className="ws-post" />
      <rect x={x + 232} y="60" width="8" height="250" className="ws-post" />
      {[120, 200, 280].map((y) => (
        <rect key={y} x={x} y={y} width="240" height="7" className="ws-shelf" />
      ))}
      {box(x + 14, 82, 54, 38, false)}
      {box(x + 74, 92, 44, 28, true)}
      {box(x + 124, 76, 60, 44, false)}
      {box(x + 190, 94, 38, 26, true)}
      {box(x + 14, 160, 70, 40, true)}
      {box(x + 90, 170, 48, 30, false)}
      {box(x + 146, 156, 80, 44, false)}
      {box(x + 14, 238, 50, 42, false)}
      {box(x + 70, 250, 62, 30, true)}
      {box(x + 140, 236, 84, 44, false)}
    </g>
  );
  return (
    <svg className="lw-scene" viewBox="0 0 900 360" preserveAspectRatio="xMidYMax meet" aria-hidden="true">
      <rect x="0" y="312" width="900" height="6" rx="3" className="ws-floor" />
      {rack(20)}
      {rack(290)}
      {/* Forklift carrying a box (drives slowly back and forth). */}
      <g className="ws-forklift">
        <rect x="600" y="232" width="96" height="58" rx="8" className="ws-truck" />
        <path d="M612 232 V188 H668 L684 232" className="ws-cab" />
        <rect x="700" y="160" width="6" height="140" className="ws-mast" />
        <rect x="706" y="282" width="56" height="6" className="ws-fork" />
        {box(712, 238, 46, 44, true)}
        <circle cx="624" cy="298" r="16" className="ws-wheel" />
        <circle cx="680" cy="298" r="16" className="ws-wheel" />
      </g>
      {/* A stack of pallets with boxes. */}
      <rect x="790" y="296" width="96" height="10" className="ws-post" />
      {box(796, 252, 40, 44, false)}
      {box(842, 260, 40, 36, true)}
      {box(808, 216, 44, 36, true)}
    </svg>
  );
}

/** Three stacked boxes drawn in navy outline. */
function OutlineBoxes() {
  const box = (x, y) => (
    <g transform={`translate(${x} ${y})`}>
      <path d="M0 14 L30 0 L60 14 L60 50 L30 64 L0 50 Z" />
      <path d="M0 14 L30 28 L60 14 M30 28 L30 64" />
      <path d="M15 7 L45 21 L45 32" />
    </g>
  );
  return (
    <svg
      className="lw-boxes"
      viewBox="-4 -4 138 132"
      fill="none"
      stroke="currentColor"
      strokeWidth="5"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {box(36, 0)}
      {box(0, 56)}
      {box(66, 52)}
    </svg>
  );
}

// Short motivational lines shown in the header's empty spaces, changing every few seconds.
const QUOTES_LEFT = ['Service Before Self', 'Integrity in Every Entry', 'Discipline Is Our Strength'];
const QUOTES_RIGHT = ['Every Item Counts', 'Accuracy Is Our Duty', 'Account for Every Item'];

function RotatingQuote({ quotes, side }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((n) => (n + 1) % quotes.length), 5000);
    return () => clearInterval(t);
  }, [quotes.length]);
  return (
    <div className={`lw-quote ${side}`} aria-live="off">
      <span key={i} className="lw-quote-text">
        <b>“</b>
        {quotes[i]}
        <b>”</b>
      </span>
    </div>
  );
}

/** Text split into letters that animate in one by one (`--i` = letter index). */
function Letters({ text, delay = 0.2, step = 0.05 }) {
  return (
    <span className="lw-letters" aria-hidden="true" style={{ '--delay': `${delay}s`, '--step': `${step}s` }}>
      {[...text].map((ch, i) => (
        <span key={i} className={ch === ' ' ? 'sp' : 'ch'} style={{ '--i': i }}>
          {ch === ' ' ? '\u00a0' : ch}
        </span>
      ))}
    </span>
  );
}

export default function Login() {
  const { login, settings } = useApp();
  const [username, setUsername] = useState(readRemembered);
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(() => !!readRemembered());
  const [show, setShow] = useState(false);
  const [caps, setCaps] = useState(false);
  const [forgot, setForgot] = useState(false);
  const [error, setError] = useState('');
  const [shake, setShake] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    const name = username.trim();
    try {
      await login(name, password);
      writeRemembered(remember ? name : '');
    } catch (err) {
      setError(err.message);
      setShake(true);
      setBusy(false);
    }
  };

  const capsCheck = (e) => setCaps(e.getModifierState?.('CapsLock') || false);

  return (
    <div className="lw-page">
      <header className="lw-head">
        {/* Emblems pinned to the far left and right; title block centred between them. */}
        <span className="lw-emb">
          <img className="lw-emblem" src="/logo-left.png" alt="Corps of Engineers emblem" />
        </span>
        <div className="lw-head-center">
          <RotatingQuote quotes={QUOTES_LEFT} side="left" />
          <span className="lw-divider" />
          <IndianFlag side="left" />
          <div className="lw-head-mid">
            <h1 aria-label={settings?.orgTitle || 'HQ CWE SHILLONG'}>
              <Letters text={settings?.orgTitle || 'HQ CWE SHILLONG'} />
            </h1>
            <span className="lw-gold-rule" />
            <p aria-label={(settings?.orgSubtitle || 'ONE MEETING EXPECTATION').replace(/"/g, '')}>
              <Letters text={(settings?.orgSubtitle || 'ONE MEETING EXPECTATION').replace(/"/g, '')} delay={0.9} step={0.035} />
            </p>
          </div>
          <IndianFlag side="right" />
          <span className="lw-divider" />
          <RotatingQuote quotes={QUOTES_RIGHT} side="right" />
        </div>
        <span className="lw-emb right">
          <img className="lw-emblem" src="/logo-right.png" alt="Military Engineer Services emblem" />
        </span>
      </header>

      <main className="lw-body">
        {/* Navy and gold waves in the corners. */}
        <svg className="lw-wave top" viewBox="0 0 600 220" preserveAspectRatio="none" aria-hidden="true">
          <path className="navy" d="M0 0 H600 C420 10 220 60 0 200 Z" />
          <path className="gold" d="M0 200 C200 70 400 20 600 0 C400 34 210 92 0 220 Z" />
        </svg>
        <svg className="lw-wave bottom" viewBox="0 0 1600 260" preserveAspectRatio="none" aria-hidden="true">
          <path className="gold" d="M0 40 C400 120 800 200 1600 150 V170 C800 220 400 150 0 70 Z" />
          <path className="navy" d="M0 70 C400 150 800 220 1600 170 V260 H0 Z" />
          <path className="gold" d="M1000 260 C1250 220 1450 160 1600 90 V120 C1460 190 1270 245 1060 260 Z" />
        </svg>
        <WarehouseScene />

        <section className="lw-left">
          <div className="lw-brand">
            <OutlineBoxes />
            <div>
              <h2>
                <span className="l1" aria-label="STORE INVENTORY">
                  <Letters text="STORE INVENTORY" delay={0.5} step={0.04} />
                </span>
                <span className="l2">MANAGEMENT SYSTEM</span>
              </h2>
              <span className="lw-gold-rule left" />
            </div>
          </div>
          <ul className="lw-features">
            {FEATURES.map(({ icon: Icon, label }, i) => (
              <li key={label} style={{ '--i': i }}>
                <Icon size={58} strokeWidth={1.8} />
                <span>{label}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* Right column: the card at the far right, with a line beside it from the header to the page end. */}
        <div className="lw-rail">
          <section className={`lw-card ${shake ? 'shake' : ''}`} onAnimationEnd={(e) => e.target === e.currentTarget && setShake(false)}>
            <div className="lw-card-head">
              <User size={30} strokeWidth={2} /> User Login
            </div>

            <CardScene />
            <form onSubmit={submit}>
              <div className="lw-field">
                <User className="lw-ico" size={22} />
                <input
                  id="username"
                  aria-label="User ID / Login ID"
                  placeholder="User ID / Login ID"
                  autoComplete="username"
                  autoFocus={!username}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                />
              </div>
              <div className="lw-field">
                <Lock className="lw-ico" size={22} />
                <input
                  id="password"
                  aria-label="Password"
                  placeholder="Password"
                  type={show ? 'text' : 'password'}
                  autoComplete="current-password"
                  autoFocus={!!username}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyUp={capsCheck}
                  onKeyDown={capsCheck}
                  onBlur={() => setCaps(false)}
                  required
                />
                <button
                  type="button"
                  className="lw-eye"
                  onClick={() => setShow((s) => !s)}
                  aria-label={show ? 'Hide password' : 'Show password'}
                  title={show ? 'Hide password' : 'Show password'}
                >
                  {show ? <EyeOff size={22} /> : <Eye size={22} />}
                </button>
              </div>
              {caps && <div className="lw-hint">Caps Lock is on</div>}

              <div className="lw-row">
                <label className="lw-check">
                  <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember Me
                </label>
                <button type="button" className="lw-link" onClick={() => setForgot((f) => !f)}>
                  Forgot Password?
                </button>
              </div>
              {forgot && (
                <div className="lw-msg info">
                  <Info size={18} /> Contact the store administrator to reset your password.
                </div>
              )}
              {error && (
                <div className="lw-msg err" role="alert">
                  <AlertCircle size={18} /> {error}
                </div>
              )}

              <button className="lw-btn" disabled={busy}>
                {busy ? <Loader2 size={24} className="lw-spin" /> : <LogIn size={24} />}
                {busy ? 'Signing in…' : 'Login'}
              </button>
            </form>

            <ul className="lw-badges">
              {BADGES.map(({ icon: Icon, label }) => (
                <li key={label}>
                  <Icon size={34} strokeWidth={1.8} />
                  <span>{label}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </main>
      <footer className="lw-foot">{DESIGNED_BY}</footer>
    </div>
  );
}
