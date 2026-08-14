import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * The page's whole prose strategy. Verbosity is the #1 failure mode here, so
 * every explanatory sentence hangs off one of these instead of occupying a line.
 * The aria-label carries the same text, so nothing is gated behind a hover.
 */
export function Why({ text }) {
  return (
    <span className="why" role="note" tabIndex={0} title={text} aria-label={text}>
      i
    </span>
  );
}

export function Segmented({ options, value, onChange, className = '', label }) {
  return (
    <div className={'segmented ' + className} role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          title={option.title || undefined}
        >
          {option.icon || null}
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Legends mirror the mark: a rect for bars and areas, a short stroke for lines.
 * A single-series chart gets none — the card title already names it.
 */
export function Legend({ series, shape = 'rect' }) {
  if (series.length < 2) return null;
  return (
    <div className="legend">
      {series.map((entry) => (
        <span key={entry.key} className="legend-item">
          <span
            className={'legend-swatch' + (shape === 'line' ? ' line' : '')}
            style={{ background: entry.color }}
            aria-hidden
          />
          {entry.mark || null}
          {entry.label}
        </span>
      ))}
    </div>
  );
}

export const SLOTS = [
  'var(--cat-1)', 'var(--cat-2)', 'var(--cat-3)', 'var(--cat-4)',
  'var(--cat-5)', 'var(--cat-6)', 'var(--cat-7)', 'var(--cat-8)',
];
export const NEUTRAL = 'var(--neutral)';

/** Colour follows the entity, never its rank in the current filter. */
export function slotColor(index) {
  return index >= 0 && index < SLOTS.length ? SLOTS[index] : NEUTRAL;
}

export function Meter({ value, max, color }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div className="meter">
      <i style={{ width: pct.toFixed(1) + '%', background: color }} />
    </div>
  );
}

/**
 * A status flag. Status colour is reserved and never doubles as a series hue,
 * and it never travels alone — every badge carries a glyph and a text label, so
 * it survives colour blindness, greyscale print and forced-colors mode.
 */
export function Badge({ level, children, title }) {
  if (level !== 'red' && level !== 'amber') return null;
  return (
    <span className={'badge ' + level} title={title || undefined}>
      <span aria-hidden>{level === 'red' ? '▲' : '△'}</span>
      {children}
    </span>
  );
}

/** localStorage-backed state that degrades to plain state in private mode. */
export function usePersisted(key, initial, allowed) {
  const [value, setValue] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      if (stored == null) return initial;
      return !allowed || allowed.includes(stored) ? stored : initial;
    } catch { return initial; }
  });
  useEffect(() => {
    try { localStorage.setItem(key, value); } catch { /* private mode */ }
  }, [key, value]);
  return [value, setValue];
}

/**
 * The rendered size of an element. The treemap's legibility floor is a PIXEL
 * question — the same share is readable on a wide map and clipped on a narrow
 * one — so the fold has to know how big the container actually is.
 */
export function useElementSize(fallback = { width: 1040, height: 340 }) {
  const ref = useRef(null);
  const [size, setSize] = useState(fallback);
  const measure = useCallback(() => {
    const node = ref.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      setSize((previous) => (
        Math.abs(previous.width - rect.width) < 1 && Math.abs(previous.height - rect.height) < 1
          ? previous
          : { width: rect.width, height: rect.height }
      ));
    }
  }, []);
  useLayoutEffect(() => {
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, [measure]);
  return [ref, size];
}
