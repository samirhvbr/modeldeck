// Issue #408 — the drill's return affordances: the zoom-in magnifier on the
// marks, the zoom-out puck, and the up-pill.
//
// THE NAMED TRIPWIRE of this slice is the first test below:
//   TRIPWIRE drillnav-block-absolute —
//   'a treemap block is position:absolute, and the zoom affordance never
//    changes that'.
// The regression it guards is the one the decider field-found in the prototype:
// the magnifier badge needs a positioned ancestor, and the obvious way to get
// one — `position: relative` on .block — knocks every square out of the treemap,
// because blocks are absolutely placed inside .treemap. Absolute IS a positioned
// ancestor, so the badge needs nothing added; the ROW shapes, which are static,
// do. Nothing in the component source says any of this, so it is held here, on
// the stylesheet the reader is actually served — both the source and the built
// page, so a stale or re-minified bundle cannot lose it either.
// VERIFIED TO FAIL by adding `position: relative` to the .block affordance rule
// in dashboard/src/theme.css (rebuild, re-run: both halves of the first test
// fail, source and built page).
//
// The second test holds the affordance itself (cursor + badge on all four
// drillable mark shapes, revealed by hover AND focus-visible); the third holds
// one-click-one-level and the crumb agreement, on the route objects themselves.
// The drawn-page half of that — the controls rendering at each level, naming the
// crumb above, absent at the overview — is click-tested in
// test/dashboard-drill-clicktest.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DASHBOARD_APP_HTML } from '../src/dashboard-app.mjs';
import { loadModule } from '../dashboard/test-support/index.mjs';

const THEME_CSS = fs.readFileSync(
  fileURLToPath(new URL('../dashboard/src/theme.css', import.meta.url)), 'utf8',
);

/** The stylesheet as the built page carries it — inlined, minified, one <style>. */
function builtCss() {
  const match = DASHBOARD_APP_HTML.match(/<style[^>]*>([\s\S]*?)<\/style>/);
  assert.ok(match, 'the built page inlines its stylesheet');
  return match[1];
}

/**
 * Every rule in a stylesheet as { selector, decls }. Deliberately dumb: comments
 * go first, then any `… { … }` pair whose body holds no nested braces, which
 * lands on the inner rules of @media blocks as well as the top-level ones.
 */
function rules(css) {
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const found = [];
  for (const match of flat.matchAll(/([^{}]+)\{([^{}]+)\}/g)) {
    const selector = match[1].trim();
    if (selector.startsWith('@')) continue;
    found.push({ selector, decls: match[2] });
  }
  return found;
}

/** The value of one property in a rule body, or null. */
function decl(decls, property) {
  const match = decls.match(new RegExp('(?:^|;)\\s*' + property + '\\s*:\\s*([^;]+)'));
  return match ? match[1].trim() : null;
}

/**
 * Rules whose SUBJECT is a treemap block — the element itself, not its ::after
 * badge, which is legitimately absolute inside it.
 */
function blockRules(css) {
  return rules(css).filter(({ selector }) => selector.split(',').some((one) => {
    const subject = one.trim().split(/[\s>+~]+/).pop() || '';
    // The minifier writes ::after as :after, so both spellings are excluded.
    return /\.block(?![-\w])/.test(subject) && !/:{1,2}after\b/.test(subject);
  }));
}

test('TRIPWIRE drillnav-block-absolute — treemap blocks stay absolutely placed', () => {
  for (const [where, css] of [['dashboard/src/theme.css', THEME_CSS], ['the built page', builtCss()]]) {
    const found = blockRules(css);
    assert.ok(found.length >= 2, where + ': the block rules are found (' + found.length + ')');

    // The layout itself: blocks are placed by percentage offsets inside
    // .treemap, so anything but absolute drops them into a vertical stack.
    const positions = found.map((rule) => decl(rule.decls, 'position')).filter(Boolean);
    assert.ok(positions.length >= 1, where + ': a block rule declares its position');
    for (const value of positions) {
      assert.equal(value, 'absolute', where + ': a block may only be position:absolute');
    }

    // …and the affordance rule is one of these, so this test is looking at the
    // rule that would carry an added `position: relative`.
    assert.ok(
      found.some((rule) => decl(rule.decls, 'cursor') === 'zoom-in'),
      where + ': the zoom-in affordance is on a block rule',
    );
  }
});

test('every drillable mark shape takes the zoom-in cursor and a magnifier badge', () => {
  for (const [where, css] of [['dashboard/src/theme.css', THEME_CSS], ['the built page', builtCss()]]) {
    const all = rules(css);
    const zoomIn = all.filter((rule) => decl(rule.decls, 'cursor') === 'zoom-in');
    const selectors = zoomIn.map((rule) => rule.selector).join(' , ');
    for (const mark of ['.block', '.folded-row', '.session-row', '.mover']) {
      assert.ok(selectors.includes(mark), where + ': ' + mark + ' is drillable-looking');
    }

    // The row shapes are static, so THEY are the ones that need a positioned
    // ancestor for the badge — the mirror image of the tripwire above.
    const rowRule = zoomIn.find((rule) => rule.selector.includes('.session-row'));
    assert.equal(decl(rowRule.decls, 'position'), 'relative', where + ': rows anchor their badge');

    // The badge itself: an inline, percent-encoded, UNQUOTED magnifier-plus —
    // quoted url() is rejected by the build's self-containment guard, and any
    // external reference would break the one-file page.
    const badge = all.find((rule) => /magnifier|circle/.test(rule.decls) || /data:image\/svg/.test(rule.decls));
    assert.ok(badge, where + ': the magnifier badge is drawn from an inline SVG');
    assert.match(badge.decls, /url\(data:image\/svg\+xml,%3Csvg/, where + ': unquoted data URI');
    assert.ok(!/url\(['"]/.test(badge.decls), where + ': never a quoted url()');

    // Hover is not the only way in: a keyboard reader gets the same promise.
    const revealed = all.filter((rule) => decl(rule.decls, 'opacity') === '1'
      && /:{1,2}after\b/.test(rule.selector));
    const revealSelectors = revealed.map((rule) => rule.selector).join(' , ');
    assert.match(revealSelectors, /:hover/, where + ': hover reveals the badge');
    assert.match(revealSelectors, /:focus-visible/, where + ': focus-visible reveals it too');
  }
});

test('the return controls step up exactly one level, and name the crumb above', async () => {
  const { parentOf } = await loadModule('src/DrillNav.jsx');

  // The overview is the top: there is nothing to return to, so both controls
  // are absent rather than inert (a disabled-looking control explains nothing).
  assert.equal(parentOf({ level: 'overview' }), null);
  assert.equal(parentOf(null), null);

  const session = {
    level: 'session',
    projectKey: '/placeholder/projects/alpha',
    projectName: 'alpha',
    pick: 'lanes',
    pickLabel: 'Build lanes',
    sessionKey: 'placeholder-session',
    sessionTitle: 'Placeholder lane session',
    rangeKey: '7d',
    scope: 'claude',
  };

  // One click, one level — the whole way up, never a jump.
  const activity = parentOf(session);
  assert.equal(activity.label, 'Build lanes');
  assert.equal(activity.to.level, 'activity');
  assert.equal(activity.to.sessionKey, null);

  const project = parentOf(activity.to);
  assert.equal(project.label, 'alpha');
  assert.equal(project.to.level, 'project');
  assert.equal(project.to.pick, null);

  const home = parentOf(project.to);
  assert.equal(home.label, 'Overview');
  assert.equal(home.to.level, 'overview');
  assert.equal(parentOf(home.to), null);

  // A session opened WITHOUT an activity level in between returns to the
  // project, which is where its crumb trail says it came from.
  const direct = parentOf({ ...session, pick: null, pickLabel: null });
  assert.equal(direct.label, 'alpha');
  assert.equal(direct.to.level, 'project');

  // The detail views hang off the landing, not off a project (#387) — so does
  // their return.
  assert.equal(parentOf({ level: 'detail', detail: 'models', projectName: 'alpha' }).to.level, 'overview');

  // The filters a level was made under ride the route, and a return must not
  // quietly drop them: useRoute stamps on `go`, but the object handed to it
  // carries the drill's own keys forward.
  assert.equal(activity.to.projectKey, session.projectKey);
  assert.equal(activity.to.selection, session.selection);
});
