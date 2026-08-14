// Same-origin reads against the daemon's existing read-only usage API.
// Nothing here fetches off-machine; every URL is a relative /api path.

export async function getJSON(path) {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) throw new Error((body && body.error) || 'HTTP ' + response.status);
  return body;
}

export const RANGES = [
  { key: 'today', label: 'Today', resolution: 'hour' },
  { key: 'yesterday', label: 'Yesterday', resolution: 'hour' },
  { key: '7d', label: '7 days', days: 7, resolution: 'day' },
  { key: '30d', label: '30 days', days: 30, resolution: 'day' },
];

export const DEFAULT_RANGE = '7d';

/**
 * Half-open [since, until) bounds in canonical ISO, which the API requires.
 *
 * Every boundary is built from local CALENDAR components, never by subtracting
 * a fixed 24 hours: on a DST transition a day is 23 or 25 hours long, and the
 * bucket enumeration (enumerateBuckets, which steps with setDate) walks
 * calendar days too. Arithmetic in milliseconds would put the range edge an
 * hour off the first bucket twice a year.
 */
export function boundsFor(rangeKey) {
  const now = new Date();
  const midnight = (offsetDays) => new Date(
    now.getFullYear(), now.getMonth(), now.getDate() + offsetDays,
  );
  if (rangeKey === 'today') {
    return { since: midnight(0).toISOString(), until: now.toISOString() };
  }
  if (rangeKey === 'yesterday') {
    return { since: midnight(-1).toISOString(), until: midnight(0).toISOString() };
  }
  const range = RANGES.find((entry) => entry.key === rangeKey) || RANGES[2];
  const days = range.days || 7;
  // The range ends now and starts at the midnight that leaves `days` calendar
  // days on the chart, today included.
  return { since: midnight(1 - days).toISOString(), until: now.toISOString() };
}

export function resolutionFor(rangeKey) {
  const range = RANGES.find((entry) => entry.key === rangeKey);
  return range ? range.resolution : 'day';
}

export function query(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  return search.toString();
}
