import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, loadModule, waitFor } from '../dashboard/test-support/index.mjs';

test('reset calendar renders absolute local times and honest unknown rows', async (t) => {
  const dom = installDom();
  globalThis.fetch = async (path) => {
    assert.equal(path, '/api/usage/resets');
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          timeZone: 'America/Los_Angeles',
          accounts: [
            {
              accountId: 'claude-placeholder',
              label: 'Placeholder Claude',
              provider: 'claude',
              windows: [
                { scope: '5-hour', resetsAt: '2026-08-18T20:30:00.000Z' },
                { scope: 'weekly', resetsAt: null },
              ],
            },
            {
              accountId: 'codex-placeholder',
              label: 'Placeholder Codex',
              provider: 'codex',
              windows: [],
            },
          ],
        };
      },
    };
  };
  const { mountResetCalendar } = await loadModule('test-support/mount-reset-calendar.jsx');
  const root = mountResetCalendar(dom.window.document.getElementById('root'));
  t.after(() => {
    root.unmount();
    dom.window.close();
  });

  await waitFor(
    () => dom.window.document.querySelectorAll('tbody tr').length === 3,
    'three reset rows',
  );
  const text = dom.window.document.body.textContent;
  assert.match(text, /Reset calendar/);
  assert.match(text, /Times shown in America\/Los_Angeles/);
  assert.match(text, /Tue, Aug 18, 2026.*1:30 PM PDT/);
  assert.equal([...dom.window.document.querySelectorAll('tbody tr')]
    .filter((row) => /unknown/.test(row.textContent)).length, 2);
  assert.match(text, /No window data/);
});
