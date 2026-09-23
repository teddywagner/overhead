import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  api,
  unwrap,
  type AdminDevice,
  type AdminLocation,
  type DisplayItem,
  type DisplayPreview,
  type DisplaySelection,
  type DisplaySettings,
  type Schemas,
  type ScoredCandidate,
} from '../api';
import {
  fmtAgo,
  fmtDuration,
  fmtNum,
  fmtTime,
  planeTitle,
  planeType,
  route,
  routeNames,
  SCOPE_LABEL,
} from '../format';

type Weights = DisplaySettings['weights'];
type ArtUrls = Schemas['ArtUrls'];
type LocationRules = Pick<
  AdminLocation,
  'search_radius_nm' | 'overhead_radius_m' | 'max_altitude_ft' | 'is_active'
>;

const WEIGHT_HELP: Record<keyof Weights, string> = {
  rarity: 'First sightings of a type or airframe',
  proximity: 'Close and low passes',
  recency: 'Newer passes in the window',
  artwork: 'Specific artwork (exact airframe > livery > type)',
  detail: 'Known model, operator, route, registration',
};

const EXCLUDED_LABEL: Record<NonNullable<ScoredCandidate['excluded']>, string> = {
  near_miss: 'near miss',
  helicopter: 'helicopter',
  not_airline: 'not an airline',
  same_airframe: 'same airframe already picked',
  same_operator_type: 'same operator + type already picked',
  over_limit: 'below the cut',
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const rulesOf = (l: AdminLocation): LocationRules => ({
  search_radius_nm: l.search_radius_nm,
  overhead_radius_m: l.overhead_radius_m,
  max_altitude_ft: l.max_altitude_ft,
  is_active: l.is_active,
});

/** datetime-local value (browser time) <-> ISO */
const toLocalInput = (iso: string) => {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

export function FrameDetail({ id }: { id: string }) {
  const [device, setDevice] = useState<AdminDevice | null>(null);
  const [location, setLocation] = useState<AdminLocation | null>(null);
  const [selections, setSelections] = useState<DisplaySelection[]>([]);
  const [artUrls, setArtUrls] = useState<ArtUrls>({});
  const [ownerLocations, setOwnerLocations] = useState<AdminLocation[]>([]);
  const [error, setError] = useState('');

  const [draft, setDraft] = useState<DisplaySettings | null>(null);
  const [pollS, setPollS] = useState(3600);
  const [rules, setRules] = useState<LocationRules | null>(null);
  const [at, setAt] = useState('');

  const [preview, setPreview] = useState<DisplayPreview | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const [detail, history] = await Promise.all([
        unwrap(api.GET('/admin/v1/devices/{id}', { params: { path: { id } } })),
        unwrap(
          api.GET('/admin/v1/devices/{id}/selections', {
            params: { path: { id }, query: { limit: 50 } },
          }),
        ),
      ]);
      setDevice(detail.device);
      setLocation(detail.location);
      setDraft(detail.device.settings);
      setPollS(detail.device.poll_interval_seconds);
      setRules(detail.location ? rulesOf(detail.location) : null);
      setSelections(history.items);
      setArtUrls(detail.art_urls);
      const locs = await unwrap(
        api.GET('/admin/v1/locations', { params: { query: { owner_id: detail.device.owner_id } } }),
      );
      setOwnerLocations(locs.items);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Live preview of the draft, debounced.
  useEffect(() => {
    if (!draft || !device?.location_id) return;
    const t = setTimeout(() => {
      unwrap(
        api.POST('/admin/v1/devices/{id}/display-preview', {
          params: { path: { id } },
          body: {
            settings: draft,
            poll_interval_seconds: pollS,
            ...(at ? { at: new Date(at).toISOString() } : {}),
          },
        }),
      )
        .then((p) => {
          setPreview(p);
          setArtUrls((urls) => ({ ...urls, ...p.art_urls }));
          setPreviewError('');
        })
        .catch((e: Error) => setPreviewError(e.message));
    }, 300);
    return () => clearTimeout(t);
  }, [id, draft, pollS, at, device?.location_id]);

  const settingsDirty = !!device && !!draft && !same(device.settings, draft);
  const pollDirty = !!device && device.poll_interval_seconds !== pollS;
  const rulesDirty = !!location && !!rules && !same(rulesOf(location), rules);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setMessage('');
    try {
      if (settingsDirty) {
        await unwrap(
          api.PATCH('/admin/v1/devices/{id}/display-settings', {
            params: { path: { id } },
            body: draft,
          }),
        );
      }
      if (pollDirty) {
        await unwrap(
          api.PATCH('/admin/v1/devices/{id}', {
            params: { path: { id } },
            body: { poll_interval_seconds: pollS },
          }),
        );
      }
      if (rulesDirty && location && rules) {
        await unwrap(
          api.PATCH('/admin/v1/locations/{id}', {
            params: { path: { id: location.id } },
            body: rules,
          }),
        );
      }
      await load();
      setMessage('Saved. The worker picks the new settings up on its next round (about a minute).');
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const changeLocation = async (locationId: string | null) => {
    setMessage('');
    try {
      await unwrap(
        api.PATCH('/admin/v1/devices/{id}', {
          params: { path: { id } },
          body: { location_id: locationId },
        }),
      );
      setPreview(null);
      await load();
    } catch (e) {
      setMessage((e as Error).message);
    }
  };

  const reset = () => {
    if (!device) return;
    setDraft(device.settings);
    setPollS(device.poll_interval_seconds);
    setRules(location ? rulesOf(location) : null);
  };

  if (error) return <p className="notice error">{error}</p>;
  if (!device || !draft) return <p className="muted">Loading…</p>;
  const tz = device.timezone;
  const set = <K extends keyof DisplaySettings>(k: K, v: DisplaySettings[K]) =>
    setDraft({ ...draft, [k]: v });
  const setWeight = (k: keyof Weights, v: number) =>
    setDraft({ ...draft, weights: { ...draft.weights, [k]: v } });

  return (
    <section>
      <p className="small">
        <a href="#/frames">← Frames</a>
      </p>
      <div className="title-row">
        <h1>{device.name}</h1>
        <span className="muted">
          {device.owner_email} · {device.location_name ?? 'no location'}
          {tz ? ` · ${tz}` : ''}
        </span>
      </div>
      <div className="stats">
        <Stat label="Enrollment" value={device.enrollment_state ?? '—'} />
        <Stat label="Last seen" value={fmtAgo(device.last_seen_at)} />
        <Stat label="Battery" value={fmtNum(device.battery_mv, ' mV')} />
        <Stat label="Signal" value={fmtNum(device.rssi, ' dBm')} />
        <Stat label="Firmware" value={device.firmware_version ?? '—'} />
        <Stat label="Changes in 24 h" value={String(device.selections_24h)} />
      </div>

      <div className="panel row-panel">
        <div>
          <div className="field-label">Watches location</div>
          <div className="muted small">
            Which of {device.owner_email ?? 'the owner'}'s locations this frame shows planes from.
          </div>
        </div>
        <div className="row">
          <select
            value={device.location_id ?? ''}
            onChange={(e) => void changeLocation(e.target.value || null)}
          >
            <option value="">none</option>
            {ownerLocations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
                {l.is_active ? '' : ' (tracking off)'}
              </option>
            ))}
          </select>
          <a className="small" href="#/locations">
            My locations →
          </a>
        </div>
      </div>
      {!device.location_id && (
        <p className="notice">This frame has no location, so there is nothing to show yet.</p>
      )}

      <div className="panel">
        <h2>Current selection</h2>
        {device.current_selection ? (
          <>
            <p className="muted small">
              Committed {fmtTime(device.current_selection.selected_at, tz)} (
              {fmtAgo(device.current_selection.selected_at)}). No poster is rendered from it yet —
              this is what the renderer will receive.
            </p>
            <PlaneCards items={device.current_selection.items} tz={tz} artUrls={artUrls} />
          </>
        ) : (
          <p className="muted">No selection committed yet.</p>
        )}
      </div>

      <div className="grid">
        <div className="panel settings">
          <div className="panel-head">
            <h2>Settings</h2>
            {(settingsDirty || pollDirty || rulesDirty) && (
              <span className="badge warn">unsaved</span>
            )}
          </div>

          <h3>What to show</h3>
          <Field label="Planes at once">
            <div className="segmented">
              {[1, 2, 3, 4].map((n) => (
                <button
                  key={n}
                  className={draft.max_planes === n ? 'on' : ''}
                  onClick={() => set('max_planes', n)}
                >
                  {n}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Rolling window" hint="Only passes from the last N hours are candidates">
            <NumberInput
              value={draft.window_hours}
              min={1}
              max={168}
              suffix="hours"
              onChange={(v) => set('window_hours', v)}
            />
          </Field>
          <Check
            label="Include near misses"
            checked={draft.include_near_misses}
            onChange={(v) => set('include_near_misses', v)}
          />
          <Check
            label="Include helicopters"
            checked={draft.include_helicopters}
            onChange={(v) => set('include_helicopters', v)}
          />
          <Check
            label="Airlines only"
            checked={draft.airline_only}
            onChange={(v) => set('airline_only', v)}
          />
          <Check
            label="One plane per operator + type"
            checked={draft.one_per_operator_type}
            onChange={(v) => set('one_per_operator_type', v)}
          />

          <h3>Scoring weights</h3>
          {(Object.keys(WEIGHT_HELP) as Array<keyof Weights>).map((k) => (
            <Field key={k} label={k} hint={WEIGHT_HELP[k]}>
              <div className="slider">
                <input
                  type="range"
                  min={0}
                  max={10}
                  step={0.5}
                  value={draft.weights[k]}
                  onChange={(e) => setWeight(k, Number(e.target.value))}
                />
                <span className="num">{draft.weights[k]}</span>
              </div>
            </Field>
          ))}

          <h3>How often</h3>
          <Field
            label="Minimum time between changes"
            hint="Each change is a new render and an e-ink refresh"
          >
            <NumberInput
              value={draft.min_dwell_minutes}
              min={0}
              max={1440}
              suffix="min"
              onChange={(v) => set('min_dwell_minutes', v)}
            />
          </Field>
          <Field
            label="Frame wakes every"
            hint="A committed change reaches the glass on the next wake"
          >
            <NumberInput
              value={Math.round(pollS / 60)}
              min={1}
              max={10080}
              suffix="min"
              onChange={(v) => setPollS(v * 60)}
            />
          </Field>
          <Field label="Quiet hours" hint="Local time; the frame does not wake">
            <div className="row">
              <HourSelect
                value={draft.quiet_start_hour}
                onChange={(h) =>
                  setDraft({
                    ...draft,
                    quiet_start_hour: h,
                    quiet_end_hour: h === null ? null : (draft.quiet_end_hour ?? 6),
                  })
                }
              />
              <span className="muted">to</span>
              <HourSelect
                value={draft.quiet_end_hour}
                onChange={(h) =>
                  setDraft({
                    ...draft,
                    quiet_end_hour: h,
                    quiet_start_hour: h === null ? null : (draft.quiet_start_hour ?? 23),
                  })
                }
              />
            </div>
          </Field>

          {rules && (
            <>
              <h3>Detection at this location</h3>
              <p className="muted small">
                Changes which future passes get recorded, not the preview.
              </p>
              <Field label="Search radius">
                <NumberInput
                  value={rules.search_radius_nm}
                  min={0.5}
                  max={250}
                  step={0.5}
                  suffix="NM"
                  onChange={(v) => setRules({ ...rules, search_radius_nm: v })}
                />
              </Field>
              <Field label="Overhead radius">
                <NumberInput
                  value={rules.overhead_radius_m}
                  min={1}
                  max={50000}
                  suffix="m"
                  onChange={(v) => setRules({ ...rules, overhead_radius_m: v })}
                />
              </Field>
              <Field label="Max altitude">
                <NumberInput
                  value={rules.max_altitude_ft}
                  min={1}
                  max={60000}
                  step={500}
                  suffix="ft"
                  onChange={(v) => setRules({ ...rules, max_altitude_ft: v })}
                />
              </Field>
              <Check
                label="Tracking active"
                checked={rules.is_active}
                onChange={(v) => setRules({ ...rules, is_active: v })}
              />
            </>
          )}

          <div className="actions">
            <button onClick={save} disabled={saving || !(settingsDirty || pollDirty || rulesDirty)}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button className="ghost" onClick={reset} disabled={saving}>
              Reset
            </button>
          </div>
          {message && <p className="notice small">{message}</p>}
        </div>

        <div className="preview">
          <div className="panel">
            <div className="panel-head">
              <h2>Preview with these settings</h2>
              <label className="small row">
                as of
                <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
                {at ? (
                  <button className="ghost small" onClick={() => setAt('')}>
                    now
                  </button>
                ) : (
                  preview && (
                    <button className="ghost small" onClick={() => setAt(toLocalInput(preview.at))}>
                      pin
                    </button>
                  )
                )}
              </label>
            </div>
            {previewError && <p className="notice error">{previewError}</p>}
            {preview && <PreviewBody preview={preview} tz={tz} />}
          </div>

          <History selections={selections} tz={tz} pollS={device.poll_interval_seconds} />
        </div>
      </div>
    </section>
  );
}

function PreviewBody({ preview, tz }: { preview: DisplayPreview; tz: string | null }) {
  const d = preview.decision;
  const decision =
    d.reason === 'initial'
      ? 'Would commit now: first selection for this frame.'
      : d.reason === 'changed'
        ? 'Would commit now: the planes changed and the minimum time has passed.'
        : d.reason === 'unchanged'
          ? 'No change: these are the planes already on the frame.'
          : d.reason === 'dwell'
            ? `Change held until ${fmtTime(d.hold_until, tz)} (minimum time between changes).`
            : 'Nothing in the window: the frame keeps its last planes.';
  const effective = Math.max(
    preview.settings.min_dwell_minutes * 60,
    preview.poll_interval_seconds,
  );

  return (
    <>
      <p className={`notice ${d.commit ? 'ok' : ''}`}>{decision}</p>
      <PlaneCards items={preview.selected} tz={tz} artUrls={preview.art_urls} />
      <p className="muted small">
        With these settings the frame can change at most every {fmtDuration(effective)} (the longer
        of the minimum time between changes and the wake interval). Next wakes:{' '}
        {preview.wake_schedule
          .slice(0, 8)
          .map((w) => fmtTime(w, tz))
          .join(' · ')}
      </p>
      <Candidates candidates={preview.candidates} tz={tz} at={preview.at} />
    </>
  );
}

function PlaneCards({
  items,
  tz,
  artUrls,
}: {
  items: DisplayItem[];
  tz: string | null;
  artUrls: ArtUrls;
}) {
  if (items.length === 0) return <p className="muted">No planes.</p>;
  return (
    <div className="cards">
      {items.map((p) => {
        const art = p.art_asset_id ? artUrls[p.art_asset_id] : undefined;
        const src = art?.thumbnail_url ?? art?.image_url;
        return (
          <div className="plane" key={p.overflight_id}>
            <div className="plane-art">
              {src ? (
                <img src={src} alt="" loading="lazy" />
              ) : (
                <span className="muted small">
                  {p.art_scope ? 'art image missing' : 'no artwork'}
                </span>
              )}
            </div>
            <div className="plane-title">{planeTitle(p)}</div>
            <div>{planeType(p)}</div>
            <div className="muted">
              {p.operator_name ?? p.operator_icao ?? 'Unknown operator'}
              {p.flight_number ? ` · ${p.flight_number}` : ''}
            </div>
            <div className="route">
              {route(p) ? (
                <>
                  <span className="strong">{route(p)}</span>
                  {routeNames(p) && <div className="muted small">{routeNames(p)}</div>}
                </>
              ) : (
                <span className="muted small">route unknown</span>
              )}
            </div>
            <div className="muted small">
              {fmtTime(p.closest_seen_at, tz)} · {fmtNum(p.minimum_distance_m, ' m')} ·{' '}
              {fmtNum(p.closest_altitude_ft, ' ft')}
            </div>
            <div className="plane-foot">
              <span className={`badge ${p.art_scope ? '' : 'warn'}`}>
                {p.art_scope ? `art: ${SCOPE_LABEL[p.art_scope]}` : 'no art'}
              </span>
              <span className="num strong">{p.score}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Candidates({
  candidates,
  tz,
  at,
}: {
  candidates: ScoredCandidate[];
  tz: string | null;
  at: string;
}) {
  if (candidates.length === 0) {
    return <p className="muted">No passes recorded in the window.</p>;
  }
  const now = Date.parse(at);
  return (
    <div className="table-wrap">
      <table className="compact">
        <thead>
          <tr>
            <th className="num">#</th>
            <th>Aircraft</th>
            <th>Route</th>
            <th>Seen</th>
            <th className="num">Dist</th>
            <th className="num">Alt</th>
            <th className="num">Seen before</th>
            <th>Score breakdown</th>
            <th className="num">Score</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          {candidates.map((c, i) => (
            <tr key={c.overflight_id} className={c.excluded ? 'dim' : 'picked'}>
              <td className="num">{i + 1}</td>
              <td>
                <div className="strong">{planeTitle(c)}</div>
                <div className="muted small">
                  {planeType(c)} · {c.operator_icao ?? '—'}
                  {c.status === 'near_miss' ? ' · near miss' : ''}
                </div>
              </td>
              <td title={routeNames(c) ?? undefined}>
                {route(c) ?? <span className="muted">—</span>}
                {c.flight_number && <div className="muted small">{c.flight_number}</div>}
              </td>
              <td title={fmtTime(c.closest_seen_at, tz)}>{fmtAgo(c.closest_seen_at, now)}</td>
              <td className="num">{fmtNum(c.minimum_distance_m, ' m')}</td>
              <td className="num">{fmtNum(c.closest_altitude_ft, ' ft')}</td>
              <td className="num" title="airframe / type sightings at this location">
                {c.airframe_sightings} / {c.type_sightings ?? '?'}
              </td>
              <td>
                <Breakdown components={c.components} />
              </td>
              <td className="num strong">{c.score}</td>
              <td>
                {c.excluded ? EXCLUDED_LABEL[c.excluded] : <span className="badge ok">shown</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Breakdown({ components }: { components: ScoredCandidate['components'] }) {
  return (
    <div className="bars">
      {(Object.keys(components) as Array<keyof typeof components>).map((k) => (
        <div key={k} className="bar" title={`${k}: ${components[k].toFixed(2)}`}>
          <i>
            <span style={{ height: `${Math.round(components[k] * 100)}%` }} />
          </i>
          <em>{k[0]}</em>
        </div>
      ))}
    </div>
  );
}

function History({
  selections,
  tz,
  pollS,
}: {
  selections: DisplaySelection[];
  tz: string | null;
  pollS: number;
}) {
  const gaps = useMemo(
    () =>
      selections
        .slice(0, -1)
        .map(
          (s, i) => (Date.parse(s.selected_at) - Date.parse(selections[i + 1]!.selected_at)) / 1000,
        ),
    [selections],
  );
  const median = gaps.length ? [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)]! : null;

  return (
    <div className="panel">
      <h2>History</h2>
      <p className="muted small">
        {selections.length === 0
          ? 'No selections committed yet.'
          : `Last ${selections.length} committed selections.` +
            (median !== null ? ` Typical time between changes: ${fmtDuration(median)}.` : '') +
            ` Each reaches the glass within ${fmtDuration(pollS)} (the wake interval).`}
      </p>
      <ol className="history">
        {selections.map((s, i) => (
          <li key={s.id}>
            <div className="history-head">
              <span className="strong">{fmtTime(s.selected_at, tz)}</span>
              <span className="badge">{s.reason}</span>
              {gaps[i] !== undefined && (
                <span className="muted small">{fmtDuration(gaps[i]!)} after the previous</span>
              )}
            </div>
            <div className="small">{s.items.map((p) => planeTitle(p)).join(' · ')}</div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <div className="muted small">{label}</div>
      <div className="strong">{value}</div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="field">
      <div>
        <div className="field-label">{label}</div>
        {hint && <div className="muted small">{hint}</div>}
      </div>
      <div>{children}</div>
    </div>
  );
}

function Check({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

function NumberInput({
  value,
  min,
  max,
  step = 1,
  suffix,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix: string;
  onChange: (v: number) => void;
}) {
  return (
    <span className="row">
      <input
        type="number"
        className="narrow"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v) && v >= min && v <= max) onChange(v);
        }}
      />
      <span className="muted small">{suffix}</span>
    </span>
  );
}

function HourSelect({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (h: number | null) => void;
}) {
  return (
    <select
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
    >
      <option value="">off</option>
      {Array.from({ length: 24 }, (_, h) => (
        <option key={h} value={h}>
          {String(h).padStart(2, '0')}:00
        </option>
      ))}
    </select>
  );
}
