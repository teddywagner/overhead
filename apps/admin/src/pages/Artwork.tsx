import { useCallback, useEffect, useState } from 'react';
import { api, unwrap, type Schemas } from '../api';
import { ArtUpload } from '../components/ArtUpload';
import { fmtAgo, SCOPE_LABEL } from '../format';
import { useUsers } from '../useUsers';

type Art = Schemas['AdminArtAsset'];
type Status = Art['status'];
type Scope = Art['scope'];

const STATUSES: Array<{ key: Status | ''; label: string }> = [
  { key: '', label: 'All' },
  { key: 'pending_review', label: 'Needs review' },
  { key: 'draft', label: 'Draft' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'archived', label: 'Archived' },
];

const STATUS_BADGE: Record<Status, string> = {
  pending_review: 'warn',
  draft: '',
  approved: 'ok',
  rejected: 'err',
  archived: '',
};

export const artTarget = (a: {
  scope: string;
  registration: string | null;
  operator_icao: string | null;
  icao_type_code: string | null;
  livery_name: string | null;
}) =>
  a.scope === 'registration'
    ? a.registration
    : a.scope === 'fallback'
      ? 'any aircraft'
      : [a.operator_icao, a.icao_type_code, a.livery_name].filter(Boolean).join(' · ');

export function Artwork() {
  const users = useUsers();
  const [status, setStatus] = useState<Status | ''>('');
  const [scope, setScope] = useState<Scope | ''>('');
  const [owner, setOwner] = useState('');
  const [data, setData] = useState<Schemas['AdminArtList'] | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<Art | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => {
    unwrap(
      api.GET('/admin/v1/art-assets', {
        params: {
          query: {
            ...(status ? { status } : {}),
            ...(scope ? { scope } : {}),
            ...(owner ? { owner_id: owner } : {}),
            limit: 200,
          },
        },
      }),
    )
      .then((d) => {
        setData(d);
        setError('');
      })
      .catch((e: Error) => setError(e.message));
  }, [status, scope, owner]);

  useEffect(() => load(), [load]);

  const total = data ? Object.values(data.counts).reduce((a, b) => a + b, 0) : 0;

  return (
    <section>
      <div className="title-row spread">
        <h1>Artwork</h1>
        <button onClick={() => setAdding(true)} disabled={users.length === 0}>
          Add artwork
        </button>
      </div>
      <p className="muted">
        The paintings frames draw planes with. The best approved match wins: exact airframe, then
        operator + type + livery, operator + type, aircraft type, generic fallback.
      </p>

      <div className="filters">
        <div className="segmented">
          {STATUSES.map((s) => (
            <button
              key={s.key}
              className={status === s.key ? 'on' : ''}
              onClick={() => setStatus(s.key)}
            >
              {s.label}
              {data && <span className="count">{s.key ? (data.counts[s.key] ?? 0) : total}</span>}
            </button>
          ))}
        </div>
        <select value={scope} onChange={(e) => setScope(e.target.value as Scope | '')}>
          <option value="">Any scope</option>
          {Object.entries(SCOPE_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
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
      {!data ? (
        <p className="muted">Loading…</p>
      ) : data.items.length === 0 ? (
        <p className="notice">
          No artwork here yet. Use <strong>Add artwork</strong>, or start from the Coverage tab to
          see which planes need it most.
        </p>
      ) : (
        <div className="art-grid">
          {data.items.map((a) => (
            <button key={a.id} className="art-card" onClick={() => setOpen(a)}>
              <div className="art-thumb">
                {a.thumbnail_url ? (
                  <img src={a.thumbnail_url} alt="" loading="lazy" />
                ) : (
                  <span>no image</span>
                )}
              </div>
              <div className="art-meta">
                <div className="row spread">
                  <span className="strong">{artTarget(a)}</span>
                  <span className={`badge ${STATUS_BADGE[a.status]}`}>
                    {a.status.replace('_', ' ')}
                  </span>
                </div>
                <div className="muted small">{SCOPE_LABEL[a.scope]}</div>
                <div className="muted small">
                  {a.sightings_30d} passes / 30 d · {a.owner_email}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      {open && (
        <ArtDetail
          art={open}
          onClose={() => setOpen(null)}
          onChanged={(a) => {
            setOpen(a);
            load();
          }}
        />
      )}
      {adding && (
        <ArtUpload
          users={users}
          prefill={owner ? { owner_id: owner } : undefined}
          onClose={() => setAdding(false)}
          onCreated={() => {
            setAdding(false);
            load();
          }}
        />
      )}
    </section>
  );
}

function ArtDetail({
  art,
  onClose,
  onChanged,
}: {
  art: Art;
  onClose: () => void;
  onChanged: (a: Art) => void;
}) {
  const [tags, setTags] = useState({
    scope: art.scope,
    registration: art.registration ?? '',
    operator_icao: art.operator_icao ?? '',
    icao_type_code: art.icao_type_code ?? '',
    livery_name: art.livery_name ?? '',
  });
  const [notes, setNotes] = useState(art.reviewer_notes ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async (call: () => Promise<Art>) => {
    setBusy(true);
    setError('');
    try {
      onChanged(await call());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const params = { params: { path: { id: art.id } } };
  const review = (status: 'approved' | 'rejected' | 'pending_review' | 'archived') =>
    run(() =>
      unwrap(
        api.POST('/admin/v1/art-assets/{id}/review', {
          ...params,
          body: { status, reviewer_notes: notes || null },
        }),
      ),
    );
  const saveTags = () =>
    run(() =>
      unwrap(
        api.PATCH('/admin/v1/art-assets/{id}', {
          ...params,
          body: {
            scope: tags.scope,
            registration: tags.registration.trim().toUpperCase() || null,
            operator_icao: tags.operator_icao.trim().toUpperCase() || null,
            icao_type_code: tags.icao_type_code.trim().toUpperCase() || null,
            livery_name: tags.livery_name.trim() || null,
            reviewer_notes: notes || null,
          },
        }),
      ),
    );

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <h2>{artTarget(art)}</h2>
          <button className="ghost small" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="art-detail">
          <div className="art-large">
            {art.image_url ? (
              <a href={art.image_url} target="_blank" rel="noreferrer">
                <img src={art.image_url} alt="" />
              </a>
            ) : (
              <p className="muted">The image file is missing from storage.</p>
            )}
          </div>
          <div>
            <dl className="facts">
              <dt>Status</dt>
              <dd>
                <span className={`badge ${STATUS_BADGE[art.status]}`}>
                  {art.status.replace('_', ' ')}
                </span>
                {art.approved_at && (
                  <span className="muted small"> approved {fmtAgo(art.approved_at)}</span>
                )}
              </dd>
              <dt>Owner</dt>
              <dd>{art.owner_email}</dd>
              <dt>Would be used for</dt>
              <dd>{art.sightings_30d} of their passes in the last 30 days</dd>
              {art.generation_model && (
                <>
                  <dt>Generated with</dt>
                  <dd>
                    {art.generation_provider} {art.generation_model}
                    {art.prompt_version ? ` (prompt ${art.prompt_version})` : ''}
                  </dd>
                </>
              )}
              <dt>Added</dt>
              <dd>{fmtAgo(art.created_at)}</dd>
            </dl>

            <h3>Tags</h3>
            <label className="stack">
              Used for
              <select
                value={tags.scope}
                onChange={(e) => setTags({ ...tags, scope: e.target.value as Scope })}
              >
                {Object.entries(SCOPE_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <div className="tag-grid">
              <label className="stack">
                Registration
                <input
                  value={tags.registration}
                  onChange={(e) => setTags({ ...tags, registration: e.target.value })}
                />
              </label>
              <label className="stack">
                Operator
                <input
                  value={tags.operator_icao}
                  onChange={(e) => setTags({ ...tags, operator_icao: e.target.value })}
                />
              </label>
              <label className="stack">
                Type
                <input
                  value={tags.icao_type_code}
                  onChange={(e) => setTags({ ...tags, icao_type_code: e.target.value })}
                />
              </label>
              <label className="stack">
                Livery
                <input
                  value={tags.livery_name}
                  onChange={(e) => setTags({ ...tags, livery_name: e.target.value })}
                />
              </label>
            </div>
            <label className="stack">
              Review notes
              <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </label>
            {error && <p className="notice error">{error}</p>}
            <div className="actions wrap">
              {art.status !== 'approved' && (
                <button disabled={busy} onClick={() => review('approved')}>
                  Approve
                </button>
              )}
              {art.status !== 'rejected' && (
                <button className="ghost" disabled={busy} onClick={() => review('rejected')}>
                  Reject
                </button>
              )}
              {art.status !== 'archived' && (
                <button className="ghost" disabled={busy} onClick={() => review('archived')}>
                  Archive
                </button>
              )}
              {art.status !== 'pending_review' && (
                <button className="ghost" disabled={busy} onClick={() => review('pending_review')}>
                  Back to review
                </button>
              )}
              <button className="ghost" disabled={busy} onClick={saveTags}>
                Save tags
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
