// Generates build-resources/logo.svg: three stacked isometric stock boxes with a gold
// "verified" badge on a navy tile. Run: node scripts/make-logo.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../build-resources/logo.svg');
const s = 232; // cube edge
const w = s * Math.cos(Math.PI / 6);
const h = s / 2;
const gap = 14;
const f = (n) => n.toFixed(1);

function cube(x, y, { tape = false } = {}) {
  const top = [[x, y], [x + w, y + h], [x, y + 2 * h], [x - w, y + h]];
  const left = [[x - w, y + h], [x, y + 2 * h], [x, y + 2 * h + s], [x - w, y + h + s]];
  const right = [[x, y + 2 * h], [x + w, y + h], [x + w, y + h + s], [x, y + 2 * h + s]];
  const p = (pts) => pts.map(([a, b]) => `${f(a)},${f(b)}`).join(' ');
  return `
    <polygon points="${p(left)}" fill="url(#left)"/>
    <polygon points="${p(right)}" fill="url(#right)"/>
    <polygon points="${p(top)}" fill="url(#top)"/>
    ${tape ? `<path d="M${f(x - w / 2)},${f(y + h / 2)} L${f(x + w / 2)},${f(y + 1.5 * h)}" stroke="#f5b921" stroke-width="22" stroke-linecap="round"/>` : ''}`;
}

// Two boxes in front (along the down-right axis), one on top, centred on the tile.
const x0 = 512 - w / 2 - gap / 2;
const y0 = 400;
const c1 = [x0, y0];
const c2 = [x0 + w + gap * Math.cos(Math.PI / 6), y0 + h + gap / 2];
const c3 = [(c1[0] + c2[0]) / 2, (c1[1] + c2[1]) / 2 - s - gap];
// Vertical centring: content spans c3.y .. c2.y + 2h + s
const top = c3[1];
const bottom = c2[1] + 2 * h + s;
const dy = 512 - (top + bottom) / 2 + 10;
const shift = (c) => [c[0], c[1] + dy];

const badge = { cx: 760, cy: 760, r: 118 };

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1f5fa8"/>
      <stop offset="1" stop-color="#0a2556"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.3" cy="0.2" r="0.8">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.22"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="top" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#eaf2fc"/>
    </linearGradient>
    <linearGradient id="left" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#cfe0f6"/>
      <stop offset="1" stop-color="#b3cbec"/>
    </linearGradient>
    <linearGradient id="right" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#8fb0de"/>
      <stop offset="1" stop-color="#6f93c9"/>
    </linearGradient>
    <linearGradient id="gold" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffd34d"/>
      <stop offset="1" stop-color="#f0a500"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="#00112e" flood-opacity="0.45"/>
    </filter>
  </defs>
  <rect x="32" y="32" width="960" height="960" rx="216" fill="url(#bg)"/>
  <rect x="32" y="32" width="960" height="960" rx="216" fill="url(#glow)"/>
  <rect x="34" y="34" width="956" height="956" rx="214" fill="none" stroke="#ffffff" stroke-opacity="0.14" stroke-width="4"/>
  <g filter="url(#shadow)">
    ${cube(...shift(c1))}
    ${cube(...shift(c2))}
    ${cube(...shift(c3), { tape: true })}
  </g>
  <g filter="url(#shadow)">
    <circle cx="${badge.cx}" cy="${badge.cy}" r="${badge.r + 18}" fill="#0b2c66"/>
    <circle cx="${badge.cx}" cy="${badge.cy}" r="${badge.r}" fill="url(#gold)"/>
    <path d="M${badge.cx - 56},${badge.cy + 2} L${badge.cx - 16},${badge.cy + 42} L${badge.cx + 60},${badge.cy - 40}"
      fill="none" stroke="#0b2c66" stroke-width="34" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
</svg>
`;
fs.writeFileSync(out, svg);
console.log(`wrote ${out}`);
