import React, { useEffect, useMemo, useState } from 'react';
import { getJSON } from './api.js';
import { ProviderMark } from './brand.jsx';
import { slotColor } from './ui.jsx';

const PROVIDER_SLOT = { claude: 1, codex: 0 };
const providerColor = (name) => slotColor(PROVIDER_SLOT[name] ?? -1);

function formatReset(iso, timeZone) {
  if (!iso) return 'unknown';
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return 'unknown';
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(value);
}

export default function ResetCalendar({ provider = '' }) {
  const [calendar, setCalendar] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    getJSON('/api/usage/resets')
      .then((value) => { if (!cancelled) setCalendar(value); })
      .catch((cause) => { if (!cancelled) setError(String(cause.message || cause)); });
    return () => { cancelled = true; };
  }, []);

  const accounts = useMemo(() => (
    (calendar?.accounts || []).filter((account) => !provider || account.provider === provider)
  ), [calendar, provider]);

  if (error) return <div className="card error">Could not load reset calendar: {error}</div>;
  if (!calendar) return <div className="card empty">Loading reset calendar…</div>;

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">Reset calendar</h2>
        <span className="card-note">Times shown in {calendar.timeZone}</span>
      </div>
      <table className="data">
        <thead>
          <tr>
            <th>Subscription</th>
            <th>Window</th>
            <th>Next reset</th>
          </tr>
        </thead>
        <tbody>
          {accounts.length === 0 ? (
            <tr><td colSpan={3} className="empty">No accounts in this scope.</td></tr>
          ) : accounts.flatMap((account) => {
            const windows = account.windows.length
              ? account.windows
              : [{ scope: 'No window data', resetsAt: null }];
            return windows.map((window, index) => (
              <tr key={account.accountId + '\u001f' + (window.scope || index)}>
                {index === 0 ? (
                  <td rowSpan={windows.length}>
                    <span className="cell-key">
                      <span className="pmark-slot" style={{ color: providerColor(account.provider) }}>
                        <ProviderMark provider={account.provider} size={12} />
                      </span>
                      {account.label}
                    </span>
                  </td>
                ) : null}
                <td>{window.scope}</td>
                <td className={window.resetsAt ? '' : 'muted'}>
                  {formatReset(window.resetsAt, calendar.timeZone)}
                </td>
              </tr>
            ));
          })}
        </tbody>
      </table>
    </section>
  );
}
