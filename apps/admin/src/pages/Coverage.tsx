import { useCallback, useEffect, useState } from 'react';
import { api, unwrap, type Schemas } from '../api';
import { ArtUpload, type ArtPrefill } from '../components/ArtUpload';
import { fmtAgo, SCOPE_LABEL } from '../format';
import { useUsers } from '../useUsers';

type Row = Schemas['CoverageRow'];

const LEVEL_BADGE: Record<string, string> = {
  registration: 'ok',
  operator_livery: 'ok',
  operator_type: 'ok',
  type: '',
  fallback: 'warn',
};

export function Coverage() {
  const users = useUsers();
  const [owner, setOwner] = useState('');
  const [days, setDays] = useState(30);
  const [nearMisses, setNearMisses] = useState(false);
  const [onlyGaps, setOnlyGaps] = useState(false);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState<ArtPrefill | null>(null);

  const load = useCallback(() => {
    unwrap(
      api.GET('/admin/v1/art-coverage', {
        params: {
          query: {
            days,
            include_near_misses: nearMisses ? 'true' : 'false',
            ...(owner ? { owner_id: owner } : {}),
          },
        },
      }),
    )
      .then((d) => {
        setRows(d.items);
        setError('');
      })
      .catch((e: Error) => setError(e.message));
  }, [owner, days, nearMisses]);

  useEffect(() => load(), [load]);

  const shown = (rows ?? []).filter(
    (r) => !onlyGaps || !r.best_scope || r.best_scope === 'type' || r.best_scope === 'fallback',
  );
  const passes = (rows ?? []).reduce((n, r) => n + r.sightings, 0);
  const specific = (rows ?? [])
    .filter((r) => r.best_scope && r.best_scope !== 'type' && r.best_scope !== 'fallback')
    .reduce((n, r) => n + r.sightings, 0);
  const any = (rows ?? []).filter((r) => r.best_scope).reduce((n, r) => n + r.sightings, 0);
  const pct = (n: number) => (passes ? Math.round((n / passes) * 100) : 0);

  return (
    <section>
      <h1>Coverage</h1>
      <p className="muted">
        What your users actually see overhead, grouped by operator and aircraft type, and whether
        there is artwork to draw it with. Most-seen first, so the top gaps are the ones worth
        painting.
      </p>
      <div className="filters">
        <select value={owner} onChange={(e) => setOwner(e.target.value)}>
          <option value="">All users</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.email}
            </option>
          ))}
        </select>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {[1, 7, 30, 90, 365].map((d) => (
            <option key={d} value={d}>
              last {d === 1 ? 'day' : `${d} days`}
            </option>
          ))}
        </select>
        <label className="check">
          <input
            type="checkbox"
            checked={nearMisses}
            onChange={(e) => setNearMisses(e.target.checked)}
          />
          include near misses
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={onlyGaps}
            onChange={(e) => setOnlyGaps(e.target.checked)}
          />
          only gaps
        </label>
      </div>

      {rows && (
        <div className="stats">
          <div className="stat">
            <div className="muted small">Passes</div>
            <div className="strong">{passes}</div>
          </div>
          <div className="stat">
            <div className="muted small">With specific art</div>
            <div className="strong">{pct(specific)}%</div>
          </div>
          <div className="stat">
            <div className="muted small">With any art</div>
            <div className="strong">{pct(any)}%</div>
          </div>
          <div className="stat">
            <div className="muted small">Operator + type groups</div>
            <div className="strong">{rows.length}</div>
          </div>
        </div>
      )}

      {error && <p className="notice error">{error}</p>}
      {!rows ? (
        <p className="muted">Loading…</p>
      ) : shown.length === 0 ? (
        <p className="notice">No recorded passes in this period.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Art</th>
                <th>Aircraft</th>
                <th>Operator</th>
                <th className="num">Passes</th>
                <th className="num">Airframes</th>
                <th>Last seen</th>
                <th>Best artwork</th>
                <th>User</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={`${r.owner_id}-${r.operator_icao}-${r.icao_type_code}`}>
                  <td>
                    <div className="mini-thumb">
                      {r.best_thumbnail_url ? (
                        <img src={r.best_thumbnail_url} alt="" loading="lazy" />
                      ) : null}
                    </div>
                  </td>
                  <td>
                    <div className="strong">
                      {[r.manufacturer, r.model].filter(Boolean).join(' ') ||
                        r.icao_type_code ||
                        'Unknown type'}
                    </div>
                    <div className="muted small">{r.icao_type_code ?? '—'}</div>
                  </td>
                  <td>
                    <div>
                      {r.operator_name ?? (r.operator_icao ? '' : 'No operator (private/unknown)')}
                    </div>
                    <div className="muted small">{r.operator_icao ?? ''}</div>
                  </td>
                  <td className="num strong">{r.sightings}</td>
                  <td className="num">
                    {r.airframes}
                    {r.airframes_with_exact_art > 0 && (
                      <div className="muted small">{r.airframes_with_exact_art} with exact art</div>
                    )}
                  </td>
                  <td>{fmtAgo(r.last_seen_at)}</td>
                  <td>
                    {r.best_scope ? (
                      <span className={`badge ${LEVEL_BADGE[r.best_scope]}`}>
                        {SCOPE_LABEL[r.best_scope]}
                      </span>
                    ) : (
                      <span className="badge err">none</span>
                    )}
                    {r.pending_count > 0 && (
                      <div className="small">
                        <a href="#/artwork">{r.pending_count} waiting for review</a>
                      </div>
                    )}
                  </td>
                  <td className="muted small">{r.owner_email}</td>
                  <td>
                    {r.icao_type_code && (
                      <button
                        className="ghost small"
                        onClick={() =>
                          setAdding({
                            owner_id: r.owner_id,
                            scope: r.operator_icao ? 'operator_type' : 'type',
                            operator_icao: r.operator_icao,
                            icao_type_code: r.icao_type_code,
                          })
                        }
                      >
                        Add art
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {adding && (
        <ArtUpload
          users={users}
          prefill={adding}
          onClose={() => setAdding(null)}
          onCreated={() => {
            setAdding(null);
            load();
          }}
        />
      )}
    </section>
  );
}
