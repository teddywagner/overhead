import { useEffect, useState } from 'react';
import { api, unwrap, type Schemas } from '../api';
import { fmtAgo } from '../format';
import { useUsers } from '../useUsers';

type Image = Schemas['AdminSourceImage'];

export function Images() {
  const users = useUsers();
  const [owner, setOwner] = useState('');
  const [items, setItems] = useState<Image[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    unwrap(
      api.GET('/admin/v1/source-images', {
        params: { query: { limit: 200, ...(owner ? { owner_id: owner } : {}) } },
      }),
    )
      .then((d) => setItems(d.items))
      .catch((e: Error) => setError(e.message));
  }, [owner]);

  return (
    <section>
      <h1>Reference images</h1>
      <p className="muted">
        Photos used as references for artwork, with their licence and attribution. Nothing is
        fetched from the source URLs; only uploaded files are shown.
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
      </div>
      {error && <p className="notice error">{error}</p>}
      {!items ? (
        <p className="muted">Loading…</p>
      ) : items.length === 0 ? (
        <p className="notice">No reference images yet.</p>
      ) : (
        <div className="art-grid">
          {items.map((i) => {
            const missingLicence = !i.license_name;
            return (
              <div key={i.id} className="art-card static">
                <div className="art-thumb">
                  {i.image_url ? (
                    <img src={i.image_url} alt="" loading="lazy" />
                  ) : (
                    <span>not uploaded</span>
                  )}
                </div>
                <div className="art-meta">
                  <div className="row spread">
                    <span className="strong">
                      {i.aircraft_registration ?? i.aircraft_type ?? 'No aircraft linked'}
                    </span>
                    {i.art_count > 0 && <span className="badge">{i.art_count} art</span>}
                  </div>
                  <div className="small">
                    {missingLicence ? (
                      <span className="badge warn">no licence recorded</span>
                    ) : i.license_url ? (
                      <a href={i.license_url} target="_blank" rel="noreferrer">
                        {i.license_name}
                      </a>
                    ) : (
                      i.license_name
                    )}
                    {i.creator && <span className="muted"> · {i.creator}</span>}
                  </div>
                  {i.attribution_text && <div className="muted small">{i.attribution_text}</div>}
                  <div className="muted small">
                    {i.source_provider}
                    {i.source_page_url && (
                      <>
                        {' · '}
                        <a href={i.source_page_url} target="_blank" rel="noreferrer">
                          source
                        </a>
                      </>
                    )}{' '}
                    · {i.owner_email} · {fmtAgo(i.created_at)}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
