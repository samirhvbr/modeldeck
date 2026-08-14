/*
 * DRILL RETURN AFFORDANCES (issue #408).
 *
 * #386 gave the drill a breadcrumb trail and the browser's back button, and the
 * decider still reported not knowing how to get back out: a crumb is a line of
 * small text in the header, far from the marks the hand is actually on. So the
 * metaphor is made literal — clicking a mark ZOOMS IN (the marks say so with a
 * zoom-in cursor and a magnifier-plus badge, in theme.css), and two controls in
 * the content area zoom back OUT, one level per click:
 *
 *   * a puck pinned low-left, where the eye is after reading a page, and
 *   * a pill at the top, naming the level a click lands on.
 *
 * Both, always on — the decider picked all three affordances after clicking a
 * prototype of each (issue #408, verdict comment).
 *
 * PRESENTATION ONLY. Nothing here owns history: every control calls the same
 * `go` the breadcrumbs call, with a route object the crumb trail could already
 * produce. If the crumbs and these controls ever disagree, the crumbs are truth.
 */
import React from 'react';

const HOME = { level: 'overview', selection: null };

/**
 * One level up from where you are, named — the crumb immediately left of the
 * current one. Kept in step with App.jsx's Crumbs deliberately: the detail views
 * and the project level both hang off the landing, and a session opened under an
 * activity returns to that activity rather than skipping to the project.
 */
export function parentOf(route) {
  if (!route || route.level === 'overview') return null;
  if (route.level === 'detail' || route.level === 'project') {
    return { label: 'Overview', to: HOME };
  }
  const project = {
    label: route.projectName || route.projectKey,
    to: { ...route, level: 'project', pick: null, pickLabel: null, sessionKey: null, sessionTitle: null },
  };
  if (route.level === 'session' && route.pick) {
    return {
      label: route.pickLabel || route.pick,
      to: { ...route, level: 'activity', sessionKey: null, sessionTitle: null },
    };
  }
  return project;
}

/** The magnifier-minus both return controls wear, so "out" reads as one idea. */
const ZoomOutGlyph = ({ size = 26 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden focusable="false">
    <circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" strokeWidth="2" />
    <line x1="7.5" y1="10.5" x2="13.5" y2="10.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    <line x1="15.5" y1="15.5" x2="21" y2="21" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
  </svg>
);

/**
 * The pinned puck: bottom-left of the CONTENT column, not the window chrome, so
 * it reads as part of the page it returns from. Absent at the overview, because
 * there is nothing above it to return to.
 */
export function ZoomOutPuck({ parent, onUp }) {
  if (!parent) return null;
  return (
    <button
      type="button"
      className="zoomout-puck"
      onClick={onUp}
      title={'Zoom out to ' + parent.label}
      aria-label={'Zoom out one level to ' + parent.label}
    >
      <ZoomOutGlyph />
      <span className="zoomout-puck-text">
        <span className="zoomout-puck-lead">Zoom out</span>
        <span className="zoomout-puck-name">{parent.label}</span>
      </span>
    </button>
  );
}

/** The top pill: the same one step, named where the reader's eye starts. */
export function UpPill({ parent, onUp }) {
  if (!parent) return null;
  return (
    <div className="uppill-wrap">
      <button
        type="button"
        className="uppill"
        onClick={onUp}
        aria-label={'Back up one level to ' + parent.label}
      >
        <span className="uppill-arrow" aria-hidden>↑</span>
        <span className="uppill-name">{parent.label}</span>
        <span className="uppill-hint">back up one level</span>
      </button>
    </div>
  );
}
