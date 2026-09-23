import { useEffect, useState } from 'react';
import { api, unwrap, type AdminDevice } from '../api';
import { fmtAgo, fmtDuration, fmtNum, planeTitle, planeType } from '../format';

export function Frames({ ownerId }: { ownerId: string | null }) {
  const [devices, setDevices] = useState<AdminDevice[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setDevices(null);
    unwrap(
      api.GET('/admin/v1/devices', { params: { query: ownerId ? { owner_id: ownerId } : {} } }),
    )
      .then((d) => setDevices(d.items))
      .catch((e: Error) => setError(e.message));
  }, [ownerId]);

  if (error) return <p className="notice error">{error}</p>;
  if (!devices) return <p className="muted">Loading…</p>;

  return (
    <section>
      <h1>Frames</h1>
      <p className="muted">
        Open a frame to change which planes it shows and how often, with a live preview.
        {ownerId && (
          <>
            {' '}
            Showing one user's frames. <a href="#/frames">Show all</a>
          </>
        )}
      </p>
      {devices.length === 0 ? (
        <p className="notice">
          No frames yet. Register one with <code>POST /api/v1/devices</code> (see the README).
        </p>
      ) : (
        <div className="frame-grid">
          {devices.map((d) => (
            <a key={d.id} className="frame-card" href={`#/frames/${d.id}`}>
              <div className="frame-card-head">
                <div>
                  <div className="plane-title">{d.name}</div>
                  <div className="muted small">
                    {d.owner_email} · {d.location_name ?? 'no location'}
                  </div>
                </div>
                <span className={`badge ${d.has_custom_settings ? '' : 'warn'}`}>
                  {d.has_custom_settings ? 'custom settings' : 'default settings'}
                </span>
              </div>

              <div className="frame-card-body">
                <div className="muted small">Selected now</div>
                {d.current_selection ? (
                  <ul className="mini-planes">
                    {d.current_selection.items.map((p) => (
                      <li key={p.overflight_id}>
                        <span className="strong">{planeTitle(p)}</span>{' '}
                        <span className="muted">{planeType(p)}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">Nothing yet: no passes recorded in the window.</p>
                )}
              </div>

              <div className="frame-card-stats small">
                <span>
                  {d.settings.max_planes} planes · {d.settings.window_hours} h window
                </span>
                <span>changes ≤ every {fmtDuration(d.settings.min_dwell_minutes * 60)}</span>
                <span>wakes every {fmtDuration(d.poll_interval_seconds)}</span>
                <span>{d.selections_24h} changes in 24 h</span>
                <span>seen {fmtAgo(d.last_seen_at)}</span>
                {d.battery_mv !== null && <span>{fmtNum(d.battery_mv, ' mV')}</span>}
              </div>

              <span className="button-like">Configure display →</span>
            </a>
          ))}
        </div>
      )}
    </section>
  );
}
