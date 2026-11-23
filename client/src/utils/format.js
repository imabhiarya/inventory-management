const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-01-19" or ISO timestamp → "19 Jan 2026" (dates are stored as UTC midnight). */
export function fmtDate(v) {
  if (!v) return '';
  const s = typeof v === 'string' ? v : new Date(v).toISOString();
  const [y, m, d] = s.slice(0, 10).split('-');
  return `${d} ${MONTHS[Number(m) - 1]} ${y}`;
}

export const isoDay = (v) => (v ? (typeof v === 'string' ? v : new Date(v).toISOString()).slice(0, 10) : '');

const inr = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qtyFmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 3 });

export const fmtMoney = (n) => (n === null || n === undefined || n === '' ? '' : inr.format(Number(n)));
export const fmtQty = (n) => (n === null || n === undefined || n === '' ? '-' : qtyFmt.format(Number(n)));

export function fyStart(fy) {
  return `${fy.slice(0, 4)}-04-01`;
}

export function fyOptions(currentFy, back = 5) {
  const start = Number(currentFy.slice(0, 4));
  const out = [];
  for (let y = start + 1; y >= start - back; y--) out.push(`${y}-${String((y + 1) % 100).padStart(2, '0')}`);
  return out;
}

export function monthOptions(fy) {
  const y = Number(fy.slice(0, 4));
  const out = [];
  for (let i = 0; i < 12; i++) {
    const m = (3 + i) % 12;
    const yy = i < 9 ? y : y + 1;
    out.push({ value: `${yy}-${String(m + 1).padStart(2, '0')}`, label: `${MONTHS[m]} ${yy}` });
  }
  return out;
}

export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** 'YYYY-MM' -> 'November 2026' ('' for an empty value). */
export const fmtMonth = (ym) => (ym ? `${MONTH_NAMES[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}` : '');

const ONES = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

/** Whole number in words, Indian style: 1 -> 'One', 125 -> 'One Hundred Twenty Five', 150000 -> 'One Lakh Fifty Thousand'. */
export function numberToWords(n) {
  n = Math.floor(Math.abs(Number(n) || 0));
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? ` ${ONES[n % 10]}` : '');
  const part = (div, name) => `${numberToWords(Math.floor(n / div))} ${name}` + (n % div ? ` ${numberToWords(n % div)}` : '');
  if (n < 1000) return part(100, 'Hundred');
  if (n < 100000) return part(1000, 'Thousand');
  if (n < 10000000) return part(100000, 'Lakh');
  return part(10000000, 'Crore');
}

export function quarterOf(isoDate) {
  const m = Number(isoDate.slice(5, 7));
  return m >= 4 && m <= 6 ? 'Q1' : m >= 7 && m <= 9 ? 'Q2' : m >= 10 ? 'Q3' : 'Q4';
}

export const QUARTERS = [
  { value: 'Q1', label: 'Q1 (Apr - Jun)' },
  { value: 'Q2', label: 'Q2 (Jul - Sep)' },
  { value: 'Q3', label: 'Q3 (Oct - Dec)' },
  { value: 'Q4', label: 'Q4 (Jan - Mar)' },
];

/** Old RV No. (receipts) or Old IV No. (issues) as a label, e.g. "Old IV No. 123"; '' when none was entered. */
export const oldNoLabel = (v) => (v?.oldRvNo ? `Old RV No. ${v.oldRvNo}` : v?.oldIvNo ? `Old IV No. ${v.oldIvNo}` : '');

/** Voucher no. with its Old RV / IV No. beside it, when one was entered. */
export const withOldNo = (no, v) => (oldNoLabel(v) ? `${no} (${oldNoLabel(v)})` : no);

const LOAN_KINDS = { ISSUE: 'Loan Issue', RECEIPT: 'Loan Receipt', BORROW: 'Store Entry', DEPOSIT: 'Loan Deposit' };
export const loanKindLabel = (k) => LOAN_KINDS[k] || k;
