import { useEffect, useState } from 'react';
import { api, unwrap, type Schemas } from '../api';
import { fmtAgo } from '../format';
import { useUsers } from '../useUsers';

type Poster = Schemas['AdminPoster'];
type Status = 'draft' | 'rendering' | 'ready' | 'failed' | 'archived';

const STATUS_BADGE: Record<string, string> = {
  ready: 'ok',
  failed: 'err',
  rendering: 'warn',
  draft: '',
  archived: '',
};

export function Posters() {
  const users = useUsers();
  const [owner, setOwner] = useState('');
  const [status, setStatus] = useState<Status | ''>('');
  const [items, setItems] = useState<Poster[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    unwrap(
      api.GET('/admin/v1/posters', {
        params: {
          query: {
            limit: 200,
            ...(owner ? { owner_id: owner } : {}),
            ...(status ? { status } : {}),
          },
        },
      }),
    )
      .then((d) => setItems(d.items))
      .catch((e: Error) => setError(e.message));
  }, [owner, status]);

  return (
    <section>
      <h1>Posters</h1>
      <p className="muted">
        Rendered portraits and the verified e-ink binaries frames download. A frame only receives a
        poster that is <span className="badge ok">ready</span> with a verified binary.
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
        <select value={status} onChange={(e) => setStatus(e.target.value as Status | '')}>
          <option value="">Any status</option>
          {Object.keys(STATUS_BADGE).map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
      {error && <p className="notice error">{error}</p>}
      {!items ? (
        <p className="muted">Loading…</p>
      ) : items.length === 0 ? (
        <p className="notice">No posters yet. Rendering is the next phase.</p>
      ) : (
        <div className="poster-grid">
          {items.map((p) => (
            <div key={p.id} className="poster-card">
              <div className="poster-previews">
                <Preview label="Full colour" url={p.full_color_preview_url} />
                <Preview label="E-ink" url={p.eink_preview_url} />
              </div>
              <div className="art-meta">
                <div className="row spread">
                  <span className="strong">
                    {p.local_date} · {p.location_name ?? 'unknown location'}
                  </span>
                  <span className={`badge ${STATUS_BADGE[p.status] ?? ''}`}>{p.status}</span>
                </div>
                <div className="muted small">
                  {p.item_count} planes · template {p.template_version} · {p.owner_email}
                </div>
                <div className="small">
                  Binary:{' '}
                  {p.binary_verified ? (
                    <span className="badge ok">verified</span>
                  ) : p.has_binary ? (
                    <span className="badge warn">uploaded, not verified</span>
                  ) : (
                    <span className="muted">none</span>
                  )}
                  {p.pinned_on.length > 0 && (
                    <span className="muted"> · pinned on {p.pinned_on.join(', ')}</span>
                  )}
                </div>
                {p.error && <p className="notice error small">{p.error}</p>}
                <div className="muted small">updated {fmtAgo(p.updated_at)}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Preview({ label, url }: { label: string; url: string | null }) {
  return (
    <div className="poster-preview">
      {url ? (
        <a href={url} target="_blank" rel="noreferrer">
          <img src={url} alt={label} loading="lazy" />
        </a>
      ) : (
        <span className="muted small">no {label.toLowerCase()} preview</span>
      )}
      <div className="muted small">{label}</div>
    </div>
  );
}
