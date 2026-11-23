// All business dates are stored as UTC midnight of the calendar day the user picked.
// The client always sends plain `YYYY-MM-DD` strings, so there is no timezone drift.

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function parseDay(value) {
  if (value instanceof Date) return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  if (typeof value !== 'string' || !ISO_DAY.test(value)) return null;
  const d = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value ? null : d;
}

export function today() {
  // "Today" in India Standard Time, as the store operates in IST.
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  return parseDay(ist.toISOString().slice(0, 10));
}

export function addDays(date, n) {
  return new Date(date.getTime() + n * 86400000);
}

/** Indian financial year label (Apr–Mar), e.g. 2025-26. */
export function fyLabel(date) {
  const y = date.getUTCFullYear();
  const start = date.getUTCMonth() >= 3 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

export function fyRange(label) {
  const m = /^(\d{4})-(\d{2})$/.exec(label || '');
  if (!m) return null;
  const start = Number(m[1]);
  if ((start + 1) % 100 !== Number(m[2])) return null;
  return { from: new Date(Date.UTC(start, 3, 1)), to: new Date(Date.UTC(start + 1, 2, 31)) };
}

export function monthRange(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(ym || '');
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  if (mo < 0 || mo > 11) return null;
  return { from: new Date(Date.UTC(y, mo, 1)), to: new Date(Date.UTC(y, mo + 1, 0)) };
}

/** Quarter within an Indian FY: Q1 Apr–Jun, Q2 Jul–Sep, Q3 Oct–Dec, Q4 Jan–Mar. */
export function quarterRange(fy, q) {
  const r = fyRange(fy);
  const n = Number(String(q).replace(/^Q/i, ''));
  if (!r || !(n >= 1 && n <= 4)) return null;
  const start = r.from.getUTCFullYear();
  const startMonth = 3 + (n - 1) * 3; // 3=Apr
  return {
    from: new Date(Date.UTC(start, startMonth, 1)),
    to: new Date(Date.UTC(start, startMonth + 3, 0)),
  };
}
