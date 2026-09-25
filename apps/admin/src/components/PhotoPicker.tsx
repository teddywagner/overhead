import { useEffect, useState } from 'react';
import {
  PROVIDER_LABEL,
  photoCandidates,
  savePhoto,
  type PhotoCandidate,
  type PhotoPickResult,
} from '../planespotters';

/** Every photo on offer for one airframe; pick one to save it. */
export function PhotoPicker({
  icao24,
  registration,
  current,
  onClose,
  onSaved,
}: {
  icao24: string;
  registration: string | null;
  current: string | null;
  onClose: () => void;
  onSaved: (saved: PhotoPickResult) => void;
}) {
  const [items, setItems] = useState<PhotoCandidate[] | null>(null);
  const [failed, setFailed] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    photoCandidates(icao24, registration)
      .then((d) => {
        setItems(d.items);
        setFailed(d.failed);
      })
      .catch((e: Error) => setError(e.message));
  }, [icao24, registration]);

  const pick = (c: PhotoCandidate) => {
    setSaving(c.image_url);
    savePhoto(icao24, registration, c.image_url)
      .then(onSaved)
      .catch((e: Error) => {
        setError(e.message);
        setSaving(null);
      });
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <h2>Photos of {registration ?? icao24.toUpperCase()}</h2>
          <button className="ghost small" onClick={onClose}>
            Close
          </button>
        </div>
        {error && <p className="notice error">{error}</p>}
        {failed.length > 0 && (
          <p className="notice">
            Couldn’t reach {failed.map((f) => PROVIDER_LABEL[f] ?? f).join(', ')} just now; try
            again in a minute.
          </p>
        )}
        {!items ? (
          !error && <p className="muted">Looking for photos…</p>
        ) : items.length === 0 ? (
          <p className="muted">No photos of this airframe on any source.</p>
        ) : (
          <div className="picker-grid">
            {items.map((c) => {
              const isCurrent = c.image_url === current;
              return (
                <div key={c.image_url} className={`pick${isCurrent ? ' on' : ''}`}>
                  <a className="plane-photo" href={c.page_url} target="_blank" rel="noreferrer">
                    <img src={c.thumbnail_url} alt="" loading="lazy" />
                  </a>
                  <div className="small">{PROVIDER_LABEL[c.provider] ?? c.provider}</div>
                  <div className="muted small credit-line">
                    {[c.creator && `© ${c.creator}`, c.license_name].filter(Boolean).join(' · ') ||
                      'No credit given'}
                  </div>
                  <button
                    className={isCurrent ? 'ghost small' : 'small'}
                    disabled={isCurrent || saving !== null}
                    onClick={() => pick(c)}
                  >
                    {isCurrent ? '★ Saved' : saving === c.image_url ? 'Saving…' : 'Use this photo'}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
