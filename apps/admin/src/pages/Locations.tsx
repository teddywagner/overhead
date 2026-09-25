import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, unwrap, type Schemas } from '../api';
import {
  Airspace,
  NM_M,
  fmtMetres,
  fmtNm,
  nearMissRadiusM,
  type AirspaceGeometry,
  type TrackPoint,
} from '../components/Airspace';
import { fmtNum, fmtTime, planeType, route, routeNames } from '../format';

type Summary = Schemas['LocationSummary'];
type Location = Schemas['Location'];
type Overflight = Schemas['Overflight'];

interface Draft {
  name: string;
  latitude: string;
  longitude: string;
  timezone: string;
  search_radius_nm: number;
  overhead_radius_m: number;
  max_altitude_ft: number;
  is_active: boolean;
}

const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const EMPTY: Draft = {
  name: 'Home',
  latitude: '',
  longitude: '',
  timezone: browserZone,
  search_radius_nm: 5,
  overhead_radius_m: 1200,
  max_altitude_ft: 15000,
  is_active: true,
};

const REASON: Record<string, string> = {
  crossed_within_overhead_radius: 'flew through the overhead zone',
  outside_overhead_radius: 'passed outside the overhead radius',
  above_max_altitude: 'inside the radius but above the max altitude',
  unknown_altitude: 'inside the radius, altitude unknown',
};

/**
 * The signed-in admin's own locations, through the regular /api/v1 routes:
 * coordinates are only ever shown to their owner, never across users.
 */
export function Locations() {
  const [items, setItems] = useState<Summary[] | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<{ id: string | null; draft: Draft } | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  // Bumped on save so the detail reloads the new radii.
  const [version, setVersion] = useState(0);

  const load = useCallback(() => {
    unwrap(api.GET('/api/v1/locations', { params: { query: { limit: 100 } } }))
      .then((d) => {
        setItems(d.items);
        setViewing((v) => v ?? d.items[0]?.id ?? null);
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(() => load(), [load]);

  const edit = async (id: string) => {
    setError('');
    try {
      const l = await unwrap(api.GET('/api/v1/locations/{id}', { params: { path: { id } } }));
      setEditing({
        id,
        draft: {
          name: l.name,
          latitude: String(l.latitude),
          longitude: String(l.longitude),
          timezone: l.timezone,
          search_radius_nm: l.search_radius_nm,
          overhead_radius_m: l.overhead_radius_m,
          max_altitude_ft: l.max_altitude_ft,
          is_active: l.is_active,
        },
      });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <section>
      <div className="title-row spread">
        <h1>My locations</h1>
        <button onClick={() => setEditing({ id: null, draft: EMPTY })}>Add location</button>
      </div>
      <p className="muted">
        Where the worker watches the sky for you. Coordinates are private: they are only shown to
        you here, never to other admins or in lists. Point a frame at a location from its Configure
        page.
      </p>
      {error && <p className="notice error">{error}</p>}
      {!items ? (
        <p className="muted">Loading…</p>
      ) : items.length === 0 ? (
        <p className="notice">You have no locations yet. Add one to start recording passes.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Time zone</th>
                <th className="num">Search radius</th>
                <th className="num">Overhead radius</th>
                <th className="num">Max altitude</th>
                <th>Tracking</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((l) => (
                <tr
                  key={l.id}
                  className={`selectable${viewing === l.id ? ' picked' : ''}`}
                  onClick={() => setViewing(l.id)}
                >
                  <td className="strong">{l.name}</td>
                  <td>{l.timezone}</td>
                  <td className="num">{l.search_radius_nm} NM</td>
                  <td className="num">{l.overhead_radius_m.toLocaleString()} m</td>
                  <td className="num">{l.max_altitude_ft.toLocaleString()} ft</td>
                  <td>
                    {l.is_active ? (
                      <span className="badge ok">on</span>
                    ) : (
                      <span className="badge">off</span>
                    )}
                  </td>
                  <td className="actions-cell">
                    <button
                      className="ghost small"
                      onClick={(e) => {
                        e.stopPropagation();
                        edit(l.id);
                      }}
                    >
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {viewing && <LocationDetail key={`${viewing}:${version}`} id={viewing} />}
      {editing && (
        <LocationForm
          id={editing.id}
          initial={editing.draft}
          onClose={() => setEditing(null)}
          onSaved={(id) => {
            setEditing(null);
            setViewing(id);
            setVersion((v) => v + 1);
            load();
          }}
        />
      )}
    </section>
  );
}

/** What each ring and dot in the airspace view means, with this location's numbers. */
function Legend({ g }: { g: AirspaceGeometry }) {
  const near = Math.min(nearMissRadiusM(g.overhead_radius_m), g.search_radius_nm * NM_M);
  const search = g.search_radius_nm * NM_M;
  return (
    <dl className="legend">
      <div>
        <dt>
          <span className="swatch overhead" /> Overhead zone
        </dt>
        <dd>
          A cylinder {fmtMetres(g.overhead_radius_m)} ({fmtNm(g.overhead_radius_m)}) around home,
          from the ground up to {g.max_altitude_ft.toLocaleString()} ft (
          {fmtMetres(g.max_altitude_ft * 0.3048)}). A plane whose track passes through it is
          recorded as <strong>overhead</strong>; these are the passes frames and posters show.
        </dd>
      </div>
      <div>
        <dt>
          <span className="swatch near" /> Near-miss ring
        </dt>
        <dd>
          {fmtMetres(near)} ({fmtNm(near)}): three times the overhead radius, at least 3 km. A plane
          that comes this close without flying through the cylinder (too high, a little too wide, or
          no altitude reported) is recorded as a <strong>near miss</strong>.
        </dd>
      </div>
      <div>
        <dt>
          <span className="swatch search" /> Search radius
        </dt>
        <dd>
          {g.search_radius_nm} NM ({fmtMetres(search)}). The worker follows every plane inside this
          circle, at any altitude, so it can catch a pass from its first sample. Planes that never
          reach the near-miss ring are not recorded.
        </dd>
      </div>
      <div>
        <dt>
          <span className="swatch dot overhead" /> <span className="swatch dot near" /> Passes
        </dt>
        <dd>
          Each dot sits at the plane’s closest approach, at its altitude, with a dashed line down to
          the ground. Blue flew overhead; orange was a near miss.
        </dd>
      </div>
    </dl>
  );
}

function LocationDetail({ id }: { id: string }) {
  const [loc, setLoc] = useState<Location | null>(null);
  const [passes, setPasses] = useState<Overflight[] | null>(null);
  const [nearMisses, setNearMisses] = useState(true);
  const [limit, setLimit] = useState(50);
  const [selected, setSelected] = useState<string | null>(null);
  const [track, setTrack] = useState<TrackPoint[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    unwrap(api.GET('/api/v1/locations/{id}', { params: { path: { id } } }))
      .then(setLoc)
      .catch((e: Error) => setError(e.message));
  }, [id]);

  useEffect(() => {
    unwrap(
      api.GET('/api/v1/overflights', {
        params: {
          query: {
            location_id: id,
            limit,
            include_position: 'true',
            ...(nearMisses ? {} : { status: 'qualified' as const }),
          },
        },
      }),
    )
      .then((d) => setPasses(d.items))
      .catch((e: Error) => setError(e.message));
  }, [id, limit, nearMisses]);

  useEffect(() => {
    setTrack(null);
    if (!selected) return;
    let live = true;
    unwrap(api.GET('/api/v1/overflights/{id}/points', { params: { path: { id: selected } } }))
      .then((d) => live && setTrack(d.items))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [selected]);

  if (error) return <p className="notice error">{error}</p>;
  if (!loc) return <p className="muted">Loading…</p>;

  const dots = (passes ?? [])
    .filter((p) => p.closest_latitude != null && p.closest_longitude != null)
    .map((p) => ({
      id: p.id,
      latitude: p.closest_latitude!,
      longitude: p.closest_longitude!,
      altitude_ft: p.closest_altitude_ft,
      qualified: p.status === 'qualified',
      label: [
        p.flight_number ?? p.callsign ?? p.registration ?? p.icao24,
        route(p),
        `${fmtNum(p.minimum_distance_m, ' m')} away`,
        p.closest_altitude_ft != null ? `${fmtNum(p.closest_altitude_ft, ' ft')}` : null,
      ]
        .filter(Boolean)
        .join(' · '),
    }));

  return (
    <>
      <h2 style={{ marginTop: 24 }}>{loc.name}: airspace</h2>
      <div className="location-detail">
        <div className="panel">
          <Airspace
            geometry={loc}
            passes={dots}
            selectedId={selected}
            onSelect={setSelected}
            track={track}
          />
        </div>
        <div className="panel">
          <h2>What you’re looking at</h2>
          <Legend g={loc} />
        </div>
      </div>

      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head">
          <h2>
            Recent passes {passes && <span className="muted small">latest {passes.length}</span>}
          </h2>
          <div className="row">
            <label className="check small">
              <input
                type="checkbox"
                checked={nearMisses}
                onChange={(e) => setNearMisses(e.target.checked)}
              />
              include near misses
            </label>
            <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
              {[25, 50, 100].map((n) => (
                <option key={n} value={n}>
                  last {n}
                </option>
              ))}
            </select>
          </div>
        </div>
        {!passes ? (
          <p className="muted">Loading…</p>
        ) : passes.length === 0 ? (
          <p className="muted">No passes recorded here yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="compact">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Flight</th>
                  <th>Aircraft</th>
                  <th className="route-cell">From → To</th>
                  <th className="num">Closest</th>
                  <th className="num">Altitude</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {passes.map((p) => {
                  const r = route(p);
                  const names = routeNames(p);
                  return (
                    <tr
                      key={p.id}
                      className={`selectable${selected === p.id ? ' picked' : ''}`}
                      onClick={() => setSelected(selected === p.id ? null : p.id)}
                      title="Show this pass's track in the airspace view"
                    >
                      <td>{fmtTime(p.closest_seen_at, loc.timezone)}</td>
                      <td>
                        <div className="strong">{p.flight_number ?? p.callsign ?? '—'}</div>
                        {p.flight_number && p.callsign && (
                          <div className="muted small">{p.callsign}</div>
                        )}
                      </td>
                      <td>
                        <div>{p.registration ?? p.icao24.toUpperCase()}</div>
                        <div className="muted small">
                          {p.aircraft ? planeType(p.aircraft) : 'Unknown type'}
                          {p.aircraft?.operator_icao ? ` · ${p.aircraft.operator_icao}` : ''}
                        </div>
                      </td>
                      <td className="route-cell">
                        {r ? (
                          <>
                            <div className="strong">{r}</div>
                            {names && <div className="muted small">{names}</div>}
                          </>
                        ) : (
                          <span className="muted small">Route unknown</span>
                        )}
                      </td>
                      <td className="num">
                        {fmtMetres(p.minimum_distance_m)}
                        <div className="muted small">{fmtNm(p.minimum_distance_m)}</div>
                      </td>
                      <td className="num">{fmtNum(p.closest_altitude_ft, ' ft')}</td>
                      <td title={REASON[p.qualification_reason]}>
                        {p.status === 'qualified' ? (
                          <span className="badge ok">overhead</span>
                        ) : (
                          <span className="badge warn">near miss</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted small">
          Routes come from adsbdb by callsign, so private and military flights usually have none.
          Click a row to draw its track above.
        </p>
      </div>
    </>
  );
}

function LocationForm({
  id,
  initial,
  onClose,
  onSaved,
}: {
  id: string | null;
  initial: Draft;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const [d, setD] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [locating, setLocating] = useState(false);

  const useHere = () => {
    if (!navigator.geolocation) return setError('This browser cannot share its location.');
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setD({
          ...d,
          latitude: pos.coords.latitude.toFixed(5),
          longitude: pos.coords.longitude.toFixed(5),
        });
        setLocating(false);
      },
      (err) => {
        setError(`Could not get your location: ${err.message}`);
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 15000 },
    );
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const latitude = Number(d.latitude);
    const longitude = Number(d.longitude);
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
      return setError('Latitude must be between -90 and 90.');
    }
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      return setError('Longitude must be between -180 and 180.');
    }
    if (d.overhead_radius_m > d.search_radius_nm * 1852) {
      return setError('The overhead radius must fit inside the search radius.');
    }
    const body = {
      name: d.name.trim(),
      latitude,
      longitude,
      timezone: d.timezone,
      search_radius_nm: d.search_radius_nm,
      overhead_radius_m: d.overhead_radius_m,
      max_altitude_ft: d.max_altitude_ft,
      is_active: d.is_active,
    };
    setBusy(true);
    setError('');
    try {
      const saved = id
        ? await unwrap(api.PATCH('/api/v1/locations/{id}', { params: { path: { id } }, body }))
        : await unwrap(api.POST('/api/v1/locations', { body }));
      onSaved(saved.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const num = (k: 'search_radius_nm' | 'overhead_radius_m' | 'max_altitude_ft') => (v: string) =>
    setD({ ...d, [k]: Number(v) });

  const lat = Number(d.latitude);
  const lon = Number(d.longitude);
  const preview =
    d.latitude !== '' &&
    d.longitude !== '' &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180 &&
    d.search_radius_nm > 0 &&
    d.overhead_radius_m > 0 &&
    d.max_altitude_ft > 0
      ? {
          latitude: lat,
          longitude: lon,
          search_radius_nm: d.search_radius_nm,
          overhead_radius_m: d.overhead_radius_m,
          max_altitude_ft: d.max_altitude_ft,
        }
      : null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal wide" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="panel-head">
          <h2>{id ? 'Edit location' : 'Add location'}</h2>
          <button type="button" className="ghost small" onClick={onClose}>
            Close
          </button>
        </div>
        <label className="stack">
          Name
          <input
            value={d.name}
            onChange={(e) => setD({ ...d, name: e.target.value })}
            required
            maxLength={100}
          />
        </label>
        <div className="tag-grid">
          <label className="stack">
            Latitude
            <input
              inputMode="decimal"
              value={d.latitude}
              placeholder="40.71280"
              onChange={(e) => setD({ ...d, latitude: e.target.value })}
              required
            />
          </label>
          <label className="stack">
            Longitude
            <input
              inputMode="decimal"
              value={d.longitude}
              placeholder="-74.00600"
              onChange={(e) => setD({ ...d, longitude: e.target.value })}
              required
            />
          </label>
        </div>
        <div className="row">
          <button type="button" className="ghost small" onClick={useHere} disabled={locating}>
            {locating ? 'Locating…' : 'Use this device’s location'}
          </button>
          <span className="muted small">Stays in your browser until you save.</span>
        </div>
        <label className="stack">
          Time zone
          <input
            value={d.timezone}
            onChange={(e) => setD({ ...d, timezone: e.target.value })}
            required
          />
        </label>
        <div className="tag-grid">
          <label className="stack">
            Search radius (NM)
            <input
              type="number"
              min={0.5}
              max={250}
              step={0.5}
              value={d.search_radius_nm}
              onChange={(e) => num('search_radius_nm')(e.target.value)}
            />
            <span className="field-hint">
              = {fmtMetres(d.search_radius_nm * NM_M)}. Planes followed.
            </span>
          </label>
          <label className="stack">
            Overhead radius (m)
            <input
              type="number"
              min={1}
              max={50000}
              value={d.overhead_radius_m}
              onChange={(e) => num('overhead_radius_m')(e.target.value)}
            />
            <span className="field-hint">= {fmtNm(d.overhead_radius_m)}. Counts as overhead.</span>
          </label>
          <label className="stack">
            Max altitude (ft)
            <input
              type="number"
              min={1}
              max={60000}
              step={500}
              value={d.max_altitude_ft}
              onChange={(e) => num('max_altitude_ft')(e.target.value)}
            />
            <span className="field-hint">
              = {fmtMetres(d.max_altitude_ft * 0.3048)}. Top of the overhead zone.
            </span>
          </label>
        </div>
        {preview && <Airspace geometry={preview} compact />}
        <label className="check">
          <input
            type="checkbox"
            checked={d.is_active}
            onChange={(e) => setD({ ...d, is_active: e.target.checked })}
          />
          Track this location
        </label>
        {error && <p className="notice error">{error}</p>}
        <div className="actions">
          <button type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}
