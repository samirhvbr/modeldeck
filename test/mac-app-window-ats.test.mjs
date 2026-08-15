import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Issue #423 (#402(a)) — TRIPWIRE mac-app-ats-loopback-only.
//
// The app window's WKWebView loads the daemon's dashboard over plain HTTP on
// 127.0.0.1, which needs an App Transport Security exception. The binding
// decision is that the exception is scoped to the loopback address and
// NOTHING else: NSAllowsArbitraryLoads (or a blanket local-networking
// switch) would relax ATS for every host the app can reach. That is a
// one-line edit away at all times and invisible in review of a plist diff,
// so it gets a test.

const plistURL = new URL('../macos/ModelDeckMac/Support/Info.plist', import.meta.url);
const plist = () => fs.readFileSync(plistURL, 'utf8');

test('the app bundle declares an ATS exception for 127.0.0.1 (#423)', () => {
  const text = plist();
  assert.match(text, /<key>NSAppTransportSecurity<\/key>/);
  assert.match(text, /<key>NSExceptionDomains<\/key>/);
  assert.match(
    text,
    /<key>127\.0\.0\.1<\/key>\s*<dict>\s*<key>NSExceptionAllowsInsecureHTTPLoads<\/key>\s*<true\/>/,
    'the loopback exception is what lets the window load http://127.0.0.1:<port>/dashboard'
  );
});

test('the ATS exception is never widened past loopback (#423)', () => {
  const text = plist();
  for (const key of [
    'NSAllowsArbitraryLoads',
    'NSAllowsArbitraryLoadsInWebContent',
    'NSAllowsArbitraryLoadsForMedia',
    'NSAllowsLocalNetworking',
  ]) {
    assert.doesNotMatch(
      text,
      new RegExp(`<key>${key}</key>`),
      `${key} relaxes ATS beyond 127.0.0.1 — #402(a) forbids it`
    );
  }
  // Exactly one exception domain, and it is the loopback literal.
  const domains = [...text.matchAll(/<key>NSExceptionDomains<\/key>\s*<dict>([\s\S]*?)<\/dict>\s*<\/dict>/g)];
  assert.equal(domains.length, 1, 'expected a single NSExceptionDomains block');
  const keys = [...domains[0][1].matchAll(/<key>([^<]+)<\/key>\s*<dict>/g)].map((m) => m[1]);
  assert.deepEqual(keys, ['127.0.0.1']);
});
