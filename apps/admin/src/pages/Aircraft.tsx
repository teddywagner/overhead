import { useCallback, useEffect, useRef, useState } from 'react';
import { api, unwrap, type Schemas } from '../api';
import { fmtAgo, fmtNum, planeType, route, routeNames } from '../format';
import { PhotoPicker } from '../components/PhotoPicker';
import {
  PROVIDER_LABEL,
  planePhoto,
  savePhoto,
  setCollectionBest,
  unsavePhoto,
  type CollectionPhoto,
  type PhotoPickResult,
  type PlanePhoto,
  type SavedPhoto,
} from '../planespotters';
import { useUsers } from '../useUsers';

type Report = Schemas['SeenAircraftReport'];
type Seen = Schemas['SeenAircraft'];
type Slot = Report['collection'][number];
type SlotKey = { operator_icao: string | null; icao_type_code: string };

const slotOf = (p: {
  operator_icao: string | null;
  icao_type_code: string | null;
}): SlotKey | null =>
  p.icao_type_code ? { operator_icao: p.operator_icao, icao_type_code: p.icao_type_code } : null;
const sameSlot = (a: SlotKey, b: { operator_icao: string | null; icao_type_code: string | null }) =>
  a.icao_type_code === b.icao_type_code && a.operator_icao === b.operator_icao;
const slotName = (p: {
  operator_name?: string | null;
  operator_icao: string | null;
  icao_type_code: string | null;
}) => `${p.operator_name ?? p.operator_icao ?? 'Private / unknown'} ${p.icao_type_code ?? ''}`;

/** Drop the pick result's extras, keeping the saved photo itself. */
const asSaved = (result: PhotoPickResult): NonNullable<SavedPhoto> => {
  const { collection: _collection, ...saved } = result;
  return saved as NonNullable<SavedPhoto>;
};

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
function Photo({
  plane,
  onPicked,
  onUnsaved,
}: {
  plane: Seen;
  onPicked: (result: PhotoPickResult) => void;
  onUnsaved: (removedId: string) => void;
}) {
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

  const act = (run: () => Promise<void>) => {
    setBusy(true);
    setError('');
    run()
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };
  const save = () =>
    photo && act(() => savePhoto(plane.icao24, plane.registration, photo.large_url).then(onPicked));
  const unsave = () => saved && act(() => unsavePhoto(saved.id).then(() => onUnsaved(saved.id)));

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
            onPicked(p);
          }}
        />
      )}
    </div>
  );
}

/** Where this airframe stands in the photo collection. */
function CollectionStatus({
  plane,
  onCompare,
}: {
  plane: Seen;
  onCompare: (candidate: CollectionPhoto) => void;
}) {
  if (!plane.icao_type_code) return null;
  const best = plane.collection_best;
  const saved = plane.saved_photo;
  const name = slotName(plane);
  if (!best) {
    return (
      <div className="small">
        <span className="badge warn" title="Save a photo of this plane to fill the slot">
          ○ Needed: {name}
        </span>
      </div>
    );
  }
  if (saved && best.id === saved.id) {
    return (
      <div className="small">
        <span className="badge ok">✓ Best {name}</span>
      </div>
    );
  }
  return (
    <div className="small row">
      <span className="muted">
        ✓ {name} collected
        {best.registration && best.registration !== plane.registration
          ? ` (${best.registration})`
          : ''}
      </span>
      {saved && (
        <button
          className="ghost small"
          onClick={() =>
            onCompare({ ...saved, icao24: plane.icao24, registration: plane.registration })
          }
        >
          Compare
        </button>
      )}
    </div>
  );
}

/**
 * The photo collection: every operator + type seen, checked off once it has a
 * best photo. Clicking a slot filters the page to it.
 */
function Collection({ slots, onPick }: { slots: Slot[]; onPick: (s: Slot) => void }) {
  const [all, setAll] = useState(false);
  const groups = new Map<string, { name: string; passes: number; slots: Slot[] }>();
  for (const s of slots) {
    const key = s.operator_icao ?? '';
    const g = groups.get(key) ?? {
      name: s.operator_name ?? s.operator_icao ?? 'Private / unknown operator',
      passes: 0,
      slots: [],
    };
    g.passes += s.passes;
    g.slots.push(s);
    groups.set(key, g);
  }
  const sorted = [...groups.values()].sort((a, b) => b.passes - a.passes);
  const shown = all ? sorted : sorted.slice(0, 8);
  const done = slots.filter((s) => s.best).length;

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>
          Photo collection{' '}
          <span className="muted small">
            {done} of {slots.length} operator + type combinations have a best photo
          </span>
        </h2>
        {sorted.length > 8 && (
          <button className="ghost small" onClick={() => setAll(!all)}>
            {all ? 'Top 8 operators' : `All ${sorted.length} operators`}
          </button>
        )}
      </div>
      <div className="bar-track collection-progress">
        <span
          className="bar-fill"
          style={{ width: `${slots.length ? (done / slots.length) * 100 : 0}%` }}
        />
      </div>
      {slots.length === 0 ? (
        <p className="muted small">No aircraft of a known type in this period.</p>
      ) : (
        <div className="collection">
          {shown.map((g) => (
            <div key={g.name} className="collection-group">
              <div className="small">
                <span className="strong">{g.name}</span>{' '}
                <span className="muted">
                  {g.slots.filter((s) => s.best).length}/{g.slots.length}
                </span>
              </div>
              <div className="chips">
                {g.slots.map((s) => (
                  <button
                    key={s.icao_type_code}
                    className={`chip${s.best ? ' done' : ''}`}
                    title={`${[s.manufacturer, s.model].filter(Boolean).join(' ') || s.icao_type_code}: ${s.passes} passes by ${s.airframes} airframes. ${
                      s.best
                        ? `Best photo: ${s.best.registration ?? s.best.icao24 ?? 'saved'}.`
                        : 'No photo yet.'
                    } Click to show these planes.`}
                    onClick={() => onPick(s)}
                  >
                    {s.best ? (
                      <img src={s.best.thumbnail_url} alt="" loading="lazy" />
                    ) : (
                      <span className="chip-empty">○</span>
                    )}
                    {s.icao_type_code}
                    {s.best && ' ✓'}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface Comparison {
  slot: SlotKey;
  name: string;
  best: CollectionPhoto;
  candidate: CollectionPhoto;
}

function ComparePhoto({
  title,
  photo,
  busy,
  current,
  onChoose,
}: {
  title: string;
  photo: CollectionPhoto;
  busy: boolean;
  current: boolean;
  onChoose: () => void;
}) {
  return (
    <div className="compare-side">
      <div className="small strong">{title}</div>
      <a
        className="compare-photo"
        href={photo.page_url ?? photo.image_url}
        target="_blank"
        rel="noreferrer"
      >
        <img src={photo.image_url} alt={photo.registration ?? ''} />
      </a>
      <div className="small">
        {photo.registration ?? photo.icao24?.toUpperCase() ?? 'Unknown airframe'} ·{' '}
        {PROVIDER_LABEL[photo.provider] ?? photo.provider}
      </div>
      <div className="muted small credit-line">
        {[photo.creator && `© ${photo.creator}`, photo.license_name].filter(Boolean).join(' · ') ||
          'No credit given'}
      </div>
      <button className={current ? 'ghost' : ''} disabled={busy} onClick={onChoose}>
        {current ? 'Keep this one' : 'Use this one'}
      </button>
    </div>
  );
}

/** Side by side: the slot's current best and a newer pick. */
function Compare({
  c,
  onClose,
  onChosen,
}: {
  c: Comparison;
  onClose: () => void;
  onChosen: (best: CollectionPhoto) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const choose = () => {
    setBusy(true);
    setError('');
    setCollectionBest(c.candidate.id)
      .then((entry) => onChosen(entry.best))
      .catch((e: Error) => {
        setError(e.message);
        setBusy(false);
      });
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <h2>Best photo for {c.name}?</h2>
          <button className="ghost small" onClick={onClose}>
            Close
          </button>
        </div>
        <p className="muted small">
          Your collection keeps one best photo per operator and aircraft type. Both photos stay
          saved on their airframes either way.
        </p>
        {error && <p className="notice error">{error}</p>}
        <div className="compare">
          <ComparePhoto
            title="Current best"
            photo={c.best}
            busy={busy}
            current
            onChoose={onClose}
          />
          <ComparePhoto
            title="New photo"
            photo={c.candidate}
            busy={busy}
            current={false}
            onChoose={choose}
          />
        </div>
      </div>
    </div>
  );
}

export function Aircraft() {
  const users = useUsers();
  const [owner, setOwner] = useState('');
  const [days, setDays] = useState(30);
  const [makers, setMakers] = useState('');
  const [nearMisses, setNearMisses] = useState(false);
  const [noHelicopters, setNoHelicopters] = useState(false);
  const [typeCode, setTypeCode] = useState<string | undefined>();
  const [operator, setOperator] = useState<string | undefined>();
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [compare, setCompare] = useState<Comparison | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    unwrap(
      api.GET('/admin/v1/seen-aircraft', {
        params: {
          query: {
            days,
            include_near_misses: nearMisses ? 'true' : 'false',
            limit: 300,
            exclude_helicopters: noHelicopters ? 'true' : 'false',
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
  }, [owner, days, makers, nearMisses, noHelicopters, typeCode, operator]);

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

  /** Set (or clear) the best photo of a slot everywhere it shows. */
  const applyBest = (slot: SlotKey, best: CollectionPhoto | null) =>
    setReport(
      (r) =>
        r && {
          ...r,
          items: r.items.map((i) => (sameSlot(slot, i) ? { ...i, collection_best: best } : i)),
          collection: (r.collection ?? []).map((s) => (sameSlot(slot, s) ? { ...s, best } : s)),
        },
    );

  const setSaved = (icao24: string, saved: SavedPhoto | null) =>
    setReport(
      (r) =>
        r && {
          ...r,
          items: r.items.map((i) => (i.icao24 === icao24 ? { ...i, saved_photo: saved } : i)),
        },
    );

  const onPicked = (plane: Seen, result: PhotoPickResult) => {
    setSaved(plane.icao24, asSaved(result));
    const { status, slot, best } = result.collection;
    if (!slot || !best) return;
    applyBest(slot, best);
    if (status === 'kept_existing') {
      setCompare({
        slot,
        name: slotName(plane),
        best,
        candidate: { ...asSaved(result), icao24: plane.icao24, registration: plane.registration },
      });
    }
  };

  const onUnsaved = (plane: Seen, removedId: string) => {
    setSaved(plane.icao24, null);
    // Removing a slot's best photo empties the slot.
    const slot = slotOf(plane);
    if (slot && plane.collection_best?.id === removedId) applyBest(slot, null);
  };

  const shownItems = (report?.items ?? []).filter(
    (p) => !onlyMissing || (p.icao_type_code && !p.collection_best),
  );

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
        <label className="check">
          <input
            type="checkbox"
            checked={noHelicopters}
            onChange={(e) => setNoHelicopters(e.target.checked)}
          />
          hide helicopters
        </label>
        <label className="check" title="Planes whose operator + type has no best photo yet">
          <input
            type="checkbox"
            checked={onlyMissing}
            onChange={(e) => setOnlyMissing(e.target.checked)}
          />
          only missing from my collection
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

          <Collection
            slots={report.collection ?? []}
            onPick={(s) => {
              setTypeCode(s.icao_type_code);
              if (s.operator_icao) setOperator(s.operator_icao);
            }}
          />

          <h2>
            Airframes{' '}
            <span className="muted small">
              {onlyMissing
                ? `${shownItems.length} missing from your collection`
                : report.items.length < report.airframes
                  ? `showing the ${report.items.length} most seen of ${report.airframes}`
                  : `${report.airframes}`}
            </span>
          </h2>
          <div className="art-grid">
            {shownItems.map((p) => (
              <div key={p.icao24} className="art-card static">
                <Photo
                  plane={p}
                  onPicked={(result) => onPicked(p, result)}
                  onUnsaved={(id) => onUnsaved(p, id)}
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
                  {(p.recent_routes ?? []).map((r) => (
                    <div
                      key={`${r.origin_code}-${r.destination_code}`}
                      className="small route"
                      title={routeNames(r) ?? undefined}
                    >
                      ✈ <span className="strong">{route(r)}</span>
                      {r.flight_number ? ` · ${r.flight_number}` : ''}
                      {r.passes > 1 ? <span className="muted"> ×{r.passes}</span> : ''}
                      {routeNames(r) && <div className="muted small">{routeNames(r)}</div>}
                    </div>
                  ))}
                  <CollectionStatus
                    plane={p}
                    onCompare={(candidate) =>
                      p.collection_best &&
                      setCompare({
                        slot: slotOf(p)!,
                        name: slotName(p),
                        best: p.collection_best,
                        candidate,
                      })
                    }
                  />
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      {compare && (
        <Compare
          c={compare}
          onClose={() => setCompare(null)}
          onChosen={(best) => {
            applyBest(compare.slot, best);
            setCompare(null);
          }}
        />
      )}
    </section>
  );
}
