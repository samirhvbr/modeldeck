// Formatters. Numbers lead everywhere on this page; these keep them short.

export function formatTokens(value) {
  const n = Number(value) || 0;
  const abs = Math.abs(n);
  if (abs >= 1e9) return trim(n / 1e9) + 'B';
  if (abs >= 1e6) return trim(n / 1e6) + 'M';
  if (abs >= 1e3) return trim(n / 1e3) + 'K';
  return String(Math.round(n));
}

function trim(value) {
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return String(Number(value.toFixed(digits)));
}

export function formatCount(value) {
  return Number(value || 0).toLocaleString('en-US');
}

/**
 * "1 session", not "1 sessions" — the decider photographed that one.
 * One helper, used everywhere a count meets a noun, so the bug cannot come back
 * one string at a time.
 */
export function plural(count, one, many) {
  const n = Number(count) || 0;
  return formatCount(n) + ' ' + (Math.abs(n) === 1 ? one : (many || one + 's'));
}

export function formatUsd(value) {
  const n = Number(value) || 0;
  if (n === 0) return '$0';
  if (Math.abs(n) >= 1000) return '$' + Math.round(n).toLocaleString('en-US');
  if (Math.abs(n) >= 10) return '$' + n.toFixed(0);
  if (Math.abs(n) >= 1) return '$' + n.toFixed(2);
  return '$' + n.toFixed(2);
}

/**
 * Money at a chosen precision. The precision is chosen once per figure set and
 * every member of the set is rounded with largest-remainder at THAT precision,
 * so the printed parts sum to the printed total. Whole dollars once a set is
 * big enough that cents are noise.
 */
export function moneyPlaces(total) {
  return Math.abs(Number(total) || 0) >= 100 ? 0 : 2;
}

export function formatMoney(value, places) {
  const n = Number(value) || 0;
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: places, maximumFractionDigits: places });
}

export function formatSubs(value) {
  return (Number(value) || 0).toFixed(2);
}

/** Share as a percent, or an em dash when the denominator is meaningless. */
export function formatPercent(part, whole) {
  if (!whole) return '—';
  return ((part / whole) * 100).toFixed(1) + '%';
}

export function formatDayShort(day) {
  const [y, m, d] = String(day).slice(0, 10).split('-').map(Number);
  if (!y) return String(day);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function formatHourShort(key) {
  const date = parseLocalKey(key);
  if (!date) return String(key);
  return date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric' });
}

/** The hour alone — "3 AM". For an axis whose whole span sits in one day. */
export function formatHourOnly(key) {
  const date = parseLocalKey(key);
  if (!date) return String(key);
  return date.toLocaleString('en-US', { hour: 'numeric' });
}

export function formatClock(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** Offset-free local keys ('YYYY-MM-DDTHH:00') parse as local wall-clock. */
export function parseLocalKey(key) {
  const text = String(key || '');
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}))?/.exec(text);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4] || 0));
}

export function localHourKey(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return (
    date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
    'T' + pad(date.getHours()) + ':00'
  );
}

export function localDayKey(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
}

export function baseName(path) {
  if (!path) return 'Unattributed';
  const parts = String(path).split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(path);
}
