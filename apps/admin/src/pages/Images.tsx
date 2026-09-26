import { useCallback, useEffect, useState } from 'react';
import { api, unwrap, type Schemas } from '../api';
import { fmtAgo } from '../format';
import { PROVIDER_LABEL } from '../planespotters';
import { useUsers } from '../useUsers';

type Image = Schemas['AdminSourceImage'];

const CUTOUT_LABEL: Record<string, string> = {
  pending: 'queued',
  processing: 'removing background…',
  failed: 'failed',
};

/** Photo, or its background-removed cutout, with the controls to make one. */
function Thumb({ image, onChange }: { image: Image; onChange: (i: Image) => void }) {
  const [showCutout, setShowCutout] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const cutout = image.cutout;
  const done = cutout?.status === 'done' && cutout.image_url;
  const working = cutout?.status === 'pending' || cutout?.status === 'processing';

  const request = () => {
    setBusy(true);
    setError('');
    unwrap(api.POST('/admin/v1/source-images/{id}/cutout', { params: { path: { id: image.id } } }))
      .then(onChange)
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  return (
    <>
      <div className="art-thumb">
        {done && showCutout ? (
          <img src={cutout.image_url!} alt="" loading="lazy" />
        ) : image.image_url ? (
          <img src={image.image_url} alt="" loading="lazy" />
        ) : (
          <span>not uploaded</span>
        )}
        {done && <span className="badge ok saved-badge">✂ cutout</span>}
      </div>
      <div className="photo-actions cutout-actions">
        {done && (
          <button className="ghost small" onClick={() => setShowCutout(!showCutout)}>
            {showCutout ? 'Show original' : 'Show cutout'}
          </button>
        )}
        {image.cutout_refusal ? (
          <span className="muted small" title={image.cutout_refusal}>
            No cutout: {image.cutout_refusal}
          </span>
        ) : working ? (
          <span className="badge">{CUTOUT_LABEL[cutout!.status]}</span>
        ) : (
          <button className="ghost small" disabled={busy} onClick={request}>
            {done
              ? 'Redo cutout'
              : cutout?.status === 'failed'
                ? 'Try again'
                : '✂ Remove background'}
          </button>
        )}
      </div>
      {cutout?.status === 'failed' && (
        <div className="notice error small">
          {cutout.error ?? 'Background removal failed'}
          {cutout.attempts > 1 ? ` (after ${cutout.attempts} tries)` : ''}
        </div>
      )}
      {error && <div className="notice error small">{error}</div>}
    </>
  );
}

export function Images() {
  const users = useUsers();
  const [owner, setOwner] = useState('');
  const [items, setItems] = useState<Image[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(
    () =>
      unwrap(
        api.GET('/admin/v1/source-images', {
          params: { query: { limit: 200, ...(owner ? { owner_id: owner } : {}) } },
        }),
      )
        .then((d) => setItems(d.items))
        .catch((e: Error) => setError(e.message)),
    [owner],
  );
  useEffect(() => {
    load();
  }, [load]);

  // While the worker has cutouts to make, check back every few seconds.
  const working = (items ?? []).some(
    (i) => i.cutout?.status === 'pending' || i.cutout?.status === 'processing',
  );
  useEffect(() => {
    if (!working) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [working, load]);

  return (
    <section>
      <h1>Reference images</h1>
      <p className="muted">
        Photos used as references for artwork, with their licence and attribution. Picked photos are
        links to their source. <strong>Remove background</strong> has the worker cut the aircraft
        out into a transparent PNG kept with the owner’s images; it is only offered where the
        licence allows edited copies (your own uploads and Wikimedia Commons photos), not for
        Planespotters.net or airport-data.com photos.
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
                <Thumb
                  image={i}
                  onChange={(next) =>
                    setItems((all) => all && all.map((x) => (x.id === next.id ? next : x)))
                  }
                />
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
                    {PROVIDER_LABEL[i.source_provider] ?? i.source_provider}
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
