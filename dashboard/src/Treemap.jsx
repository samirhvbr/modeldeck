import React from 'react';
import { useElementSize } from './ui.jsx';

/**
 * Squarified treemap (Bruls/Huizing/van Wijk) — rows are packed along the
 * shorter side so blocks stay as square as the shares allow. Ported from the
 * design reference prototype, whose block layout the decider signed off on.
 *
 * The rect is in PERCENT, and cells are applied as left/top/width/height
 * percentages, so the map is resolution-independent.
 */
export function squarify(items, rect) {
  const placed = [];
  let queue = items.filter((item) => item.value > 0);
  let { x, y, w, h } = rect;
  const total = queue.reduce((sum, item) => sum + item.value, 0);
  if (!total || w <= 0 || h <= 0) return placed;
  const scale = (w * h) / total;
  const worst = (row, len) => {
    if (!row.length) return Infinity;
    const areas = row.map((item) => item.value * scale);
    const sum = areas.reduce((acc, area) => acc + area, 0);
    const max = Math.max(...areas);
    const min = Math.min(...areas);
    if (!sum || !min) return Infinity;
    return Math.max((len * len * max) / (sum * sum), (sum * sum) / (len * len * min));
  };
  const layout = (row, len, vertical) => {
    const sum = row.reduce((acc, item) => acc + item.value * scale, 0);
    const thickness = sum / len;
    let offset = vertical ? y : x;
    for (const item of row) {
      const side = (item.value * scale) / thickness;
      if (vertical) placed.push({ item, x, y: offset, w: thickness, h: side });
      else placed.push({ item, x: offset, y, w: side, h: thickness });
      offset += side;
    }
    if (vertical) { x += thickness; w -= thickness; } else { y += thickness; h -= thickness; }
  };
  let row = [];
  let guard = 0;
  while (queue.length && guard < 500) {
    guard += 1;
    const vertical = w >= h;
    const len = vertical ? h : w;
    if (len <= 0) break;
    const candidate = row.concat([queue[0]]);
    if (!row.length || worst(candidate, len) <= worst(row, len)) {
      row = candidate;
      queue = queue.slice(1);
    } else {
      layout(row, len, vertical);
      row = [];
    }
  }
  if (row.length) {
    const vertical = w >= h;
    layout(row, vertical ? h : w, vertical);
  }
  return placed;
}

/*
 * MINIMUM LEGIBLE CELL.
 *
 * The decider scoped the map to one low-burn day and got a row of slivers with
 * their labels sheared off at the container edge — a 0.07 block clipped in half.
 * A treemap has no honest way to draw a 0.3% share at label size, so it should
 * not try: anything that would land below the legible floor is folded into one
 * "+N more" block that opens on click.
 *
 * The test is GEOMETRIC, not a share threshold — the same 0.4% share is legible
 * on a wide map and not on a narrow one, and folding by share alone would hide
 * blocks that had room. So: lay the map out, measure the cells in real pixels,
 * fold the single smallest offender, and lay it out again. Folding one at a time
 * matters — removing the smallest gives every survivor more area, and often the
 * second-smallest then fits.
 *
 * The floor is derived from what a block actually has to draw, not guessed:
 *
 *   padding 8 + 8   name line 15   gap 1   value line 16   =  48px
 *
 * which is the COMPACT block (name + value, no sub-label). Anything shorter
 * cannot render both lines, and a flex column asked to fit them anyway crushes
 * the name to a sliver — which is exactly the sheared-off label the decider
 * photographed. 50 leaves a pixel of slack for sub-pixel layout.
 */
export const MIN_CELL_W = 86; // px — a short name and a value at 11px
export const MIN_CELL_H = 50; // px — padding + name line + value line
export const FULL_CELL_H = 68; // px — the above plus the sub-label line
export const FULL_CELL_W = 130; // px — narrower than this the sub-label wraps
export const MICRO_CELL_H = 34; // px — below this only the name fits

export function collapseSmall(items, { width, height, minW = MIN_CELL_W, minH = MIN_CELL_H }) {
  const live = items.filter((item) => item.value > 0);
  const fits = (cell) => (cell.w / 100) * width >= minW && (cell.h / 100) * height >= minH;
  if (live.length <= 1 || !(width > 0) || !(height > 0)) {
    return { kept: live, hidden: [], moreFits: false };
  }
  let kept = live.slice();
  const hidden = [];
  let placed = [];

  for (let guard = 0; guard < live.length + 1; guard += 1) {
    const hiddenValue = hidden.reduce((sum, item) => sum + item.value, 0);
    const probe = hiddenValue > 0 ? kept.concat([{ key: '__more', value: hiddenValue }]) : kept;
    placed = squarify(probe, { x: 0, y: 0, w: 100, h: 100 });
    // The "+N more" cell is held to the SAME floor as every other block — a
    // clipped "+1 more" is the very bug this exists to prevent.
    const offenders = placed.filter((cell) => !fits(cell));
    if (!offenders.length) break;
    if (kept.length <= 1) break;
    // When the ONLY illegible cell is the remainder itself, folding real blocks
    // to make room for it trades legible projects for a "+N more" nobody asked
    // to see: a tiny tail beside one large project would empty the map down to
    // that project. The caller already has the honest exit — moreFits stays
    // false and the chip moves to the card head — so stop here.
    if (offenders.every((cell) => cell.item.key === '__more')) break;

    // Fold the smallest survivor. The order is a stable function of the values,
    // never of what the pointer is near.
    //
    // PINNED items (a project carrying a detector flag — it is on the map so
    // the reader sees the flag) are folded last, because folding the others
    // first gives the flagged block more area and usually lifts it over the
    // floor on its own. But the pin is VOID once the pinned block is itself the
    // illegible one: protecting a sliver by folding legible blocks around it
    // trades a whole readable map for one badge, and the badge is unreadable
    // anyway. Then it folds like anything else, and its flag travels with it
    // into the folded list.
    const offending = new Set(offenders.map((cell) => cell.item.key));
    const pinnedIsOffending = kept.some((item) => item.pin && offending.has(item.key));
    const loose = kept.filter((item) => !item.pin);
    const pool = (!pinnedIsOffending && loose.length) ? loose : kept;
    let smallest = pool[0];
    for (const item of pool) if (item.value < smallest.value) smallest = item;
    kept = kept.filter((item) => item !== smallest);
    hidden.push(smallest);
  }

  hidden.sort((a, b) => b.value - a.value);
  // Whether the remainder can be DRAWN. When the tail is a rounding error next
  // to the leader, no layout gives it a legible cell, so the caller puts it in
  // the card head instead of forcing a sliver onto the map.
  const moreCell = placed.find((cell) => cell.item.key === '__more');
  return { kept, hidden, moreFits: !!moreCell && fits(moreCell) };
}

/**
 * items: [{ key, name, value, valueLabel, subLabel, color, disabled, title,
 *           badge, marks }]
 * A block always carries its own name — the light-mode relief rule (three
 * categorical hues sit below 3:1 on the light surface) is satisfied by the
 * visible direct label on every mark.
 */
export default function Treemap({ items, height = 340, onSelect, emptyText = 'Nothing to show in this range.' }) {
  // Density is decided in PIXELS, not in percent of the map. The same 6% cell
  // is roomy on a wide map and two crushed lines on a narrow one, and it is the
  // pixel height that decides whether a line of text fits.
  const [ref, size] = useElementSize({ width: 1040, height });
  const placed = squarify(items, { x: 0, y: 0, w: 100, h: 100 });
  if (!placed.length) return <div className="empty">{emptyText}</div>;

  return (
    // No list roles here: they would have to sit ON the blocks, and a
    // role="listitem" overrides a button's own role — a screen reader would
    // announce an activatable cell as a plain list item. The blocks stay
    // buttons, each with its own aria-label.
    <div className="treemap" ref={ref} style={{ height }}>
      {placed.map(({ item, x, y, w, h }) => {
        const px = (w / 100) * size.width;
        const py = (h / 100) * size.height;
        // Drop a line rather than squash all of them: sub-label first, then the
        // value. Every block keeps its name at full size, always.
        const compact = py < FULL_CELL_H || px < FULL_CELL_W;
        const micro = py < MICRO_CELL_H;
        const className = 'block'
          + (compact ? ' compact' : '')
          + (micro ? ' micro' : '')
          + (item.more ? ' more' : '');
        return (
          <button
            key={item.key}
            type="button"
            className={className}
            // aria-disabled, NOT the disabled attribute (issue #411). A block
            // that does not open carries the sentence saying WHY on its title —
            // and a disabled button is removed from the tab order and stops
            // firing the pointer events a native tooltip needs, so that sentence
            // would reach neither a hovering mouse in Chrome/Safari nor a
            // keyboard at all. This keeps the block reachable and readable while
            // the click guard below is what actually makes it inert.
            aria-disabled={item.disabled || !onSelect ? true : undefined}
            title={item.title || item.name}
            aria-label={item.name + ', ' + item.valueLabel + (item.subLabel ? ', ' + item.subLabel : '')}
            onClick={() => onSelect && !item.disabled && onSelect(item)}
            style={{
              left: x + '%',
              top: y + '%',
              width: w + '%',
              height: h + '%',
              // A 2px surface gap does the separating — never a border around
              // the mark. The left rule carries the entity's colour at full
              // strength; the wash keeps large blocks quiet.
              background: `color-mix(in srgb, ${item.color} 14%, var(--surface))`,
              boxShadow: `inset 0 0 0 1px var(--border), inset 3px 0 0 0 ${item.color}`,
              outline: '2px solid var(--page)',
              outlineOffset: 0,
            }}
          >
            {/* A row, not a text line: the mark and the badge hold their size
                and the NAME is what ellipsises, so a flag is never the thing
                that gets cut off. */}
            <span className="block-name">
              {item.marks || null}
              <span className="block-name-text">{item.name}</span>
              {item.badge || null}
            </span>
            <span className="block-value">{item.valueLabel}</span>
            {item.subLabel ? <span className="block-sub">{item.subLabel}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
