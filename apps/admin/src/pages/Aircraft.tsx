import { useCallback, useEffect, useRef, useState } from 'react';
import { api, unwrap, type Schemas } from '../api';
import { fmtAgo, fmtNum, planeType } from '../format';
import { PhotoPicker } from '../components/PhotoPicker';
import {
  PROVIDER_LABEL,
  planePhoto,
  savePhoto,
  unsavePhoto,
  type PlanePhoto,
  type SavedPhoto,
} from '../planespotters';
import { useUsers } from '../useUsers';

type Report = Schemas['SeenAircraftReport'];
type Seen = Schemas['SeenAircraft'];

const MAKERS = [
  ['', 'All makers'],
  ['airbus,boeing', 'Airbus & Boeing'],
  ['airbus', 'Airbus'],
  ['boeing', 'Boeing'],
] as const;

const TOP = 12;

interface Bar {
  key: string | null;
  label: string;
  sub: string;
  passes: number;
  airframes: number;
}

/** Ranked horizontal bars; clicking one filters the page to it. */
function Distribution({
  title,
  bars,
  active,
  onPick,
}: {
  title: string;
  bars: Bar[];
  active: string | undefined;
  onPick: (key: string | undefined) => void;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? bars : bars.slice(0, TOP);
  const max = Math.max(1, ...bars.map((b) => b.passes));
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>{title}</h2>
        {bars.length > TOP && (
          <button className="ghost small" onClick={() => setAll(!all)}>
            {all ? `Top ${TOP}` : `All ${bars.length}`}
          </button>
        )}
      </div>
      {bars.length === 0 ? (
        <p className="muted small">Nothing yet.</p>
      ) : (
        <div className="bars">
          {shown.map((b) => {
            const on = active !== undefined && b.key === active;
            return (
              <button
                key={b.key ?? '(none)'}
                className={`bar-row${on ? ' on' : ''}`}
                disabled={!b.key}
                title={`${b.label}: ${b.passes} passes by ${b.airframes} airframes${
                  b.key ? (on ? ' — click to clear' : ' — click to filter') : ''
                }`}
                onClick={() => onPick(on ? undefined : (b.key ?? undefined))}
              >
                <span className="bar-label">
                  {b.label}
                  <span className="muted small"> {b.sub}</span>
                </span>
                <span className="bar-track">
                  <span className="bar-fill" style={{ width: `${(b.passes / max) * 100}%` }} />
                </span>
                <span className="bar-value">{b.passes}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * The card photo: the saved pick when there is one, else Planespotters'
 * default (fetched once the card scrolls into view). Save keeps the shown
 * photo; More photos opens the picker.
 */
function Photo({ plane, onChange }: { plane: Seen; onChange: (saved: SavedPhoto | null) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [photo, setPhoto] = useState<PlanePhoto | null | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const saved = plane.saved_photo;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => e?.isIntersecting && setVisible(true), {
      rootMargin: '200px',
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || saved) return;
    let live = true;
    planePhoto(plane.icao24, plane.registration)
      .then((p) => live && setPhoto(p))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [visible, saved, plane.icao24, plane.registration]);

  const act = (run: () => Promise<SavedPhoto | null>) => {
    setBusy(true);
    setError('');
    run()
      .then(onChange)
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };
  const save = () =>
    photo && act(() => savePhoto(plane.icao24, plane.registration, photo.large_url));
  const unsave = () => saved && act(() => unsavePhoto(saved.id).then(() => null));

  const shown = saved
    ? { src: saved.thumbnail_url, link: saved.page_url ?? saved.image_url }
    : photo
      ? { src: photo.large_url, link: photo.page_url }
      : null;
  const credit = saved
    ? [saved.creator && `© ${saved.creator}`, PROVIDER_LABEL[saved.provider] ?? saved.provider]
        .filter(Boolean)
        .join(' · ')
    : photo
      ? `© ${photo.photographer} · Planespotters.net`
      : '\u00a0';

  return (
    <div className="plane-photo-wrap">
      <div className="plane-photo" ref={ref}>
        {shown ? (
          <a href={shown.link} target="_blank" rel="noreferrer">
            <img src={shown.src} alt={plane.registration ?? plane.icao24} loading="lazy" />
          </a>
        ) : (
          <span className="muted small">
            {failed
              ? 'Photo lookup failed'
              : photo === null
                ? 'No photo on Planespotters'
                : 'Loading photo…'}
          </span>
        )}
        {saved && <span className="badge ok saved-badge">★ Saved</span>}
      </div>
      <div className="muted small credit">{credit}</div>
      <div className="photo-actions">
        {saved ? (
          <button className="ghost small" disabled={busy} onClick={unsave}>
            Unsave
          </button>
        ) : (
          <button className="ghost small" disabled={busy || !photo} onClick={save}>
            ★ Save
          </button>
        )}
        <button className="ghost small" onClick={() => setPicking(true)}>
          More photos
        </button>
      </div>
      {error && <div className="notice error small">{error}</div>}
      {picking && (
        <PhotoPicker
          icao24={plane.icao24}
          registration={plane.registration}
          current={saved?.image_url ?? null}
          onClose={() => setPicking(false)}
          onSaved={(p) => {
            setPicking(false);
            onChange(p);
          }}
        />
      )}
    </div>
  );
}

export function Aircraft() {
  const users = useUsers();
  const [owner, setOwner] = useState('');
  const [days, setDays] = useState(30);
  const [makers, setMakers] = useState('');
  const [nearMisses, setNearMisses] = useState(false);
  const [typeCode, setTypeCode] = useState<string | undefined>();
  const [operator, setOperator] = useState<string | undefined>();
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    unwrap(
      api.GET('/admin/v1/seen-aircraft', {
        params: {
          query: {
            days,
            include_near_misses: nearMisses ? 'true' : 'false',
            limit: 300,
            ...(owner ? { owner_id: owner } : {}),
            ...(makers ? { manufacturer: makers } : {}),
            ...(typeCode ? { type_code: typeCode } : {}),
            ...(operator ? { operator } : {}),
          },
        },
      }),
    )
      .then((d) => {
        setReport(d);
        setError('');
      })
      .catch((e: Error) => setError(e.message));
  }, [owner, days, makers, nearMisses, typeCode, operator]);

  useEffect(() => load(), [load]);

  const typeBars: Bar[] = (report?.by_type ?? []).map((t) => ({
    key: t.icao_type_code,
    label: planeType(t),
    sub: t.icao_type_code ?? '',
    passes: t.passes,
    airframes: t.airframes,
  }));
  const operatorBars: Bar[] = (report?.by_operator ?? []).map((o) => ({
    key: o.operator_icao,
    label: o.operator_name ?? (o.operator_icao ? o.operator_icao : 'No operator (private/unknown)'),
    sub: o.operator_name ? (o.operator_icao ?? '') : '',
    passes: o.passes,
    airframes: o.airframes,
  }));
  const capped = (n: number) => (n >= 50 ? '50+' : String(n));

  return (
    <section>
      <h1>Aircraft</h1>
      <p className="muted">
        Every plane recorded overhead, most-seen first, with how the passes split by aircraft type
        and operator. Click a bar to filter. Photos come from Planespotters.net.
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
        <select value={makers} onChange={(e) => setMakers(e.target.value)}>
          {MAKERS.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
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
        {typeCode && (
          <button className="ghost small" onClick={() => setTypeCode(undefined)}>
            Type {typeCode} ✕
          </button>
        )}
        {operator && (
          <button className="ghost small" onClick={() => setOperator(undefined)}>
            Operator {operator} ✕
          </button>
        )}
      </div>

      {error && <p className="notice error">{error}</p>}
      {!report ? (
        !error && <p className="muted">Loading…</p>
      ) : report.passes === 0 ? (
        <p className="notice">No recorded passes match these filters.</p>
      ) : (
        <>
          <div className="stats">
            <div className="stat">
              <div className="muted small">Passes</div>
              <div className="strong">{fmtNum(report.passes)}</div>
            </div>
            <div className="stat">
              <div className="muted small">Airframes</div>
              <div className="strong">{fmtNum(report.airframes)}</div>
            </div>
            <div className="stat">
              <div className="muted small">Aircraft types</div>
              <div className="strong">{capped(report.by_type.length)}</div>
            </div>
            <div className="stat">
              <div className="muted small">Operators</div>
              <div className="strong">{capped(report.by_operator.length)}</div>
            </div>
          </div>

          <div className="dist-grid">
            <Distribution
              title="Passes by aircraft type"
              bars={typeBars}
              active={typeCode}
              onPick={setTypeCode}
            />
            <Distribution
              title="Passes by operator"
              bars={operatorBars}
              active={operator}
              onPick={setOperator}
            />
          </div>

          <h2>
            Airframes{' '}
            <span className="muted small">
              {report.items.length < report.airframes
                ? `showing the ${report.items.length} most seen of ${report.airframes}`
                : `${report.airframes}`}
            </span>
          </h2>
          <div className="art-grid">
            {report.items.map((p) => (
              <div key={p.icao24} className="art-card static">
                <Photo
                  plane={p}
                  onChange={(saved) =>
                    setReport(
                      (r) =>
                        r && {
                          ...r,
                          items: r.items.map((i) =>
                            i.icao24 === p.icao24 ? { ...i, saved_photo: saved } : i,
                          ),
                        },
                    )
                  }
                />
                <div className="art-meta">
                  <div className="strong">{p.registration ?? p.icao24.toUpperCase()}</div>
                  <div>{planeType(p)}</div>
                  <div className="muted small">
                    {p.operator_name ?? p.operator_icao ?? 'No operator'}
                    {p.icao_type_code ? ` · ${p.icao_type_code}` : ''}
                  </div>
                  <div className="small">
                    <span className="strong">{p.passes}</span> {p.passes === 1 ? 'pass' : 'passes'}{' '}
                    · last {fmtAgo(p.last_seen_at)}
                    {p.users > 1 ? ` · ${p.users} users` : ''}
                  </div>
                  <div className="muted small">
                    closest {fmtNum(p.closest_distance_m, ' m')} · {p.icao24}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
