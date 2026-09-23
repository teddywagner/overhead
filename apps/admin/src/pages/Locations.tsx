import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, unwrap, type Schemas } from '../api';

type Summary = Schemas['LocationSummary'];

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

/**
 * The signed-in admin's own locations, through the regular /api/v1 routes:
 * coordinates are only ever shown to their owner, never across users.
 */
export function Locations() {
  const [items, setItems] = useState<Summary[] | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<{ id: string | null; draft: Draft } | null>(null);

  const load = useCallback(() => {
    unwrap(api.GET('/api/v1/locations', { params: { query: { limit: 100 } } }))
      .then((d) => setItems(d.items))
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
                <tr key={l.id}>
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
                    <button className="ghost small" onClick={() => edit(l.id)}>
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <LocationForm
          id={editing.id}
          initial={editing.draft}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </section>
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
  onSaved: () => void;
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
      if (id) await unwrap(api.PATCH('/api/v1/locations/{id}', { params: { path: { id } }, body }));
      else await unwrap(api.POST('/api/v1/locations', { body }));
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const num = (k: 'search_radius_nm' | 'overhead_radius_m' | 'max_altitude_ft') => (v: string) =>
    setD({ ...d, [k]: Number(v) });

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
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
          </label>
        </div>
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
