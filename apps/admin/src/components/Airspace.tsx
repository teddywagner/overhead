import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

/**
 * A location's airspace in 3D: the search radius, the near-miss ring and the
 * overhead cylinder (overhead radius × max altitude), with recorded passes at
 * their closest approach and the selected pass's track. Plain SVG with an
 * orthographic camera; drag to orbit.
 *
 * Coordinates stay in the browser. The street map is opt-in because its tiles
 * come from OpenStreetMap, whose servers then see which area is shown.
 */

export interface AirspaceGeometry {
  latitude: number;
  longitude: number;
  search_radius_nm: number;
  overhead_radius_m: number;
  max_altitude_ft: number;
}

export interface AirspacePass {
  id: string;
  latitude: number;
  longitude: number;
  altitude_ft: number | null;
  qualified: boolean;
  /** Tooltip text. */
  label: string;
}

export interface TrackPoint {
  latitude: number;
  longitude: number;
  altitude_ft: number | null;
}

export const NM_M = 1852;
const FT_M = 0.3048;
const EARTH_M = 6_371_008.8;
const RAD = Math.PI / 180;

/** Mirrors the worker's default (flight-tracking finalizePass). */
export const nearMissRadiusM = (overheadRadiusM: number) => Math.max(overheadRadiusM * 3, 3000);

type Extent = 'overhead' | 'near' | 'search';
const EXTENT_LABEL: Record<Extent, string> = {
  overhead: 'Overhead zone',
  near: 'Near-miss ring',
  search: 'Search radius',
};
const VIEWS = { top: [0, 90], '3d': [-30, 28], side: [0, 2] } as const;

const W = 800;
const PAD = 28;

/** East/north metres from the centre (equirectangular; fine at these ranges). */
function localXY(lat0: number, lon0: number, lat: number, lon: number): [number, number] {
  return [(lon - lon0) * RAD * EARTH_M * Math.cos(lat0 * RAD), (lat - lat0) * RAD * EARTH_M];
}

function hull(points: Array<[number, number]>): Array<[number, number]> {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) =>
    (a[0]! - o[0]!) * (b[1]! - o[1]!) - (a[1]! - o[1]!) * (b[0]! - o[0]!);
  const half = (pts: Array<[number, number]>) => {
    const out: Array<[number, number]> = [];
    for (const q of pts) {
      while (out.length >= 2 && cross(out[out.length - 2]!, out[out.length - 1]!, q) <= 0) {
        out.pop();
      }
      out.push(q);
    }
    out.pop();
    return out;
  };
  return [...half(p), ...half([...p].reverse())];
}

export const fmtMetres = (m: number) =>
  m >= 10_000
    ? `${(m / 1000).toFixed(0)} km`
    : m >= 1000
      ? `${(m / 1000).toFixed(1)} km`
      : `${Math.round(m)} m`;
export const fmtNm = (m: number) => `${(m / NM_M).toFixed(m < NM_M * 10 ? 1 : 0)} NM`;

/** OSM tiles covering a square of `radius` metres around the centre. */
function tilesFor(lat0: number, lon0: number, radius: number) {
  const perTile = (2 * radius) / 3;
  const z = Math.max(
    2,
    Math.min(17, Math.floor(Math.log2((40_075_016 * Math.cos(lat0 * RAD)) / perTile))),
  );
  const n = 2 ** z;
  const tx = (lon: number) => ((lon + 180) / 360) * n;
  const ty = (lat: number) =>
    ((1 - Math.log(Math.tan(lat * RAD) + 1 / Math.cos(lat * RAD)) / Math.PI) / 2) * n;
  const dLat = radius / (EARTH_M * RAD);
  const dLon = dLat / Math.cos(lat0 * RAD);
  const x0 = Math.floor(tx(lon0 - dLon));
  const x1 = Math.floor(tx(lon0 + dLon));
  const y0 = Math.floor(ty(Math.min(85, lat0 + dLat)));
  const y1 = Math.floor(ty(Math.max(-85, lat0 - dLat)));
  const lonOf = (x: number) => (x / n) * 360 - 180;
  const latOf = (y: number) => Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) / RAD;
  const tiles = [];
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      if (y < 0 || y >= n) continue;
      const [west, north] = localXY(lat0, lon0, latOf(y), lonOf(x));
      const [east, south] = localXY(lat0, lon0, latOf(y + 1), lonOf(x + 1));
      tiles.push({
        key: `${z}/${x}/${y}`,
        href: `https://tile.openstreetmap.org/${z}/${((x % n) + n) % n}/${y}.png`,
        west,
        north,
        width: east - west,
        height: north - south,
      });
    }
  }
  return tiles;
}

export function Airspace({
  geometry,
  passes = [],
  selectedId = null,
  onSelect,
  track = null,
  compact = false,
}: {
  geometry: AirspaceGeometry;
  passes?: AirspacePass[];
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
  track?: TrackPoint[] | null;
  compact?: boolean;
}) {
  const [azimuth, setAzimuth] = useState<number>(VIEWS['3d'][0]);
  const [elevation, setElevation] = useState<number>(VIEWS['3d'][1]);
  const [extent, setExtent] = useState<Extent>(compact ? 'search' : 'near');
  const [exaggeration, setExaggeration] = useState(1);
  const [showMap, setShowMap] = useState(false);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  // A drag that ends over a dot must not also select it.
  const dragged = useRef(false);

  const H = compact ? 360 : 520;
  const { latitude: lat0, longitude: lon0 } = geometry;
  const overheadR = geometry.overhead_radius_m;
  const nearR = Math.min(nearMissRadiusM(overheadR), geometry.search_radius_nm * NM_M);
  const searchR = geometry.search_radius_nm * NM_M;
  const R =
    extent === 'overhead' ? overheadR * 1.6 : extent === 'near' ? nearR * 1.3 : searchR * 1.05;
  const ceiling = geometry.max_altitude_ft * FT_M * exaggeration;

  const th = azimuth * RAD;
  const ph = elevation * RAD;
  const cosT = Math.cos(th);
  const sinT = Math.sin(th);
  const sinP = Math.sin(ph);
  const cosP = Math.cos(ph);

  // Fit the view to the shown extent (a disc) plus the overhead cylinder.
  const { scale, cx, cy } = useMemo(() => {
    const pts: Array<[number, number]> = [];
    for (let i = 0; i < 36; i++) {
      const a = (i / 36) * 2 * Math.PI;
      for (const [r, z] of [
        [R, 0],
        [Math.min(overheadR, R), ceiling],
      ] as const) {
        const x = r * Math.cos(a);
        const y = r * Math.sin(a);
        pts.push([x * cosT - y * sinT, -((x * sinT + y * cosT) * sinP + z * cosP)]);
      }
    }
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const [minX, maxX, minY, maxY] = [
      Math.min(...xs),
      Math.max(...xs),
      Math.min(...ys),
      Math.max(...ys),
    ];
    const s = Math.min((W - 2 * PAD) / (maxX - minX || 1), (H - 2 * PAD) / (maxY - minY || 1));
    return {
      scale: s,
      cx: W / 2 - ((minX + maxX) / 2) * s,
      cy: H / 2 - ((minY + maxY) / 2) * s,
    };
  }, [R, overheadR, ceiling, cosT, sinT, sinP, cosP, H]);

  const project = (x: number, y: number, z: number): [number, number, number] => {
    const x1 = x * cosT - y * sinT;
    const y1 = x * sinT + y * cosT;
    return [cx + x1 * scale, cy - (y1 * sinP + z * cosP) * scale, y1 * cosP - z * sinP];
  };
  const ring = (r: number, z: number, n = 96) =>
    Array.from({ length: n + 1 }, (_, i) => {
      const a = (i / n) * 2 * Math.PI;
      const [sx, sy] = project(r * Math.cos(a), r * Math.sin(a), z);
      return `${sx.toFixed(1)},${sy.toFixed(1)}`;
    }).join(' ');
  const alt = (ft: number | null) => (ft === null ? 0 : Math.max(0, ft) * FT_M * exaggeration);

  const cylinder = useMemo(() => {
    const pts: Array<[number, number]> = [];
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * 2 * Math.PI;
      for (const z of [0, ceiling]) {
        const x = overheadR * Math.cos(a);
        const y = overheadR * Math.sin(a);
        const x1 = x * cosT - y * sinT;
        const y1 = x * sinT + y * cosT;
        pts.push([cx + x1 * scale, cy - (y1 * sinP + z * cosP) * scale]);
      }
    }
    return hull(pts)
      .map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`)
      .join(' ');
  }, [overheadR, ceiling, cosT, sinT, sinP, cosP, cx, cy, scale]);

  const tiles = useMemo(() => (showMap ? tilesFor(lat0, lon0, R) : []), [showMap, lat0, lon0, R]);

  // Rightmost point of a ring on screen, for its label.
  const labelAt = (r: number, z = 0): [number, number] => {
    const [sx, sy] = project(r * cosT, -r * sinT, z);
    return [sx, sy];
  };

  const dots = passes
    .map((p) => {
      const [x, y] = localXY(lat0, lon0, p.latitude, p.longitude);
      const z = alt(p.altitude_ft);
      const top = project(x, y, z);
      const ground = project(x, y, 0);
      return { p, top, ground, far: Math.hypot(x, y) > R * 1.02 };
    })
    .filter((d) => !d.far)
    .sort((a, b) => b.top[2] - a.top[2]);

  const trackPts = track?.map((t) => {
    const [x, y] = localXY(lat0, lon0, t.latitude, t.longitude);
    return { x, y, z: alt(t.altitude_ft) };
  });
  const line = (pts: Array<[number, number, number]>) =>
    pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');

  // Altitude ruler at the centre: a tick every 5,000 ft (or 1,000 ft when low).
  const stepFt = geometry.max_altitude_ft > 8000 ? 5000 : 1000;
  const ticks: number[] = [];
  // The ceiling has its own label.
  for (let f = stepFt; f < geometry.max_altitude_ft; f += stepFt) ticks.push(f);

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    drag.current = { x: e.clientX, y: e.clientY, moved: false };
    dragged.current = false;
  };
  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved) {
      if (Math.abs(dx) + Math.abs(dy) < 4) return;
      // Capture only once it is a drag, so plain clicks still reach the dots.
      d.moved = true;
      dragged.current = true;
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    d.x = e.clientX;
    d.y = e.clientY;
    setAzimuth((a) => (a - dx * 0.4 + 360) % 360);
    setElevation((v) => Math.max(0, Math.min(90, v + dy * 0.3)));
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  const groundMatrix = [
    scale * cosT,
    -scale * sinP * sinT,
    -scale * sinT,
    -scale * sinP * cosT,
    cx,
    cy,
  ].join(' ');
  const [homeX, homeY] = project(0, 0, 0);
  const [ceilX, ceilY] = project(0, 0, ceiling);
  const [ceilLabelX, ceilLabelY] = labelAt(overheadR, ceiling);
  const [northX, northY] = project(0, R * 0.97, 0);

  return (
    <div className="airspace">
      <div className="airspace-controls">
        <div className="segmented">
          {(Object.keys(VIEWS) as Array<keyof typeof VIEWS>).map((v) => (
            <button
              key={v}
              type="button"
              className={
                azimuth === VIEWS[v][0] && elevation === VIEWS[v][1] ? 'on small' : 'small'
              }
              onClick={() => {
                setAzimuth(VIEWS[v][0]);
                setElevation(VIEWS[v][1]);
              }}
            >
              {v === 'top' ? 'Top down' : v === '3d' ? '3D' : 'Side'}
            </button>
          ))}
        </div>
        <div className="segmented">
          {(Object.keys(EXTENT_LABEL) as Extent[]).map((k) => (
            <button
              key={k}
              type="button"
              className={extent === k ? 'on small' : 'small'}
              onClick={() => setExtent(k)}
            >
              {EXTENT_LABEL[k]}
            </button>
          ))}
        </div>
        <label className="check small" title="Stretch heights so low passes stand out">
          Height ×
          <select value={exaggeration} onChange={(e) => setExaggeration(Number(e.target.value))}>
            {[1, 2, 3, 5, 10].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label
          className="check small"
          title="Loads map tiles from OpenStreetMap, whose servers then see which area is shown"
        >
          <input type="checkbox" checked={showMap} onChange={(e) => setShowMap(e.target.checked)} />
          street map
        </label>
      </div>
      <svg
        className="airspace-canvas"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="3D view of the location's airspace and recorded passes"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClick={(e) => {
          if (!dragged.current && e.target === e.currentTarget) onSelect?.(null);
        }}
      >
        <defs>
          <clipPath id="airspace-disc" clipPathUnits="userSpaceOnUse">
            <circle cx={0} cy={0} r={R} />
          </clipPath>
        </defs>

        {/* Ground plane: map, grid and rings. */}
        <g transform={`matrix(${groundMatrix})`}>
          <circle cx={0} cy={0} r={R} className="as-ground" />
          {tiles.length > 0 && (
            <g clipPath="url(#airspace-disc)" className="as-tiles">
              <g transform="scale(1,-1)">
                {tiles.map((t) => (
                  <image
                    key={t.key}
                    href={t.href}
                    x={t.west}
                    y={-t.north}
                    width={t.width}
                    height={t.height}
                    preserveAspectRatio="none"
                  />
                ))}
              </g>
            </g>
          )}
          <line
            x1={-R}
            y1={0}
            x2={R}
            y2={0}
            className="as-grid"
            vectorEffect="non-scaling-stroke"
          />
          <line
            x1={0}
            y1={-R}
            x2={0}
            y2={R}
            className="as-grid"
            vectorEffect="non-scaling-stroke"
          />
        </g>
        {searchR <= R * 1.02 && <polyline points={ring(searchR, 0)} className="as-ring search" />}
        <polyline points={ring(nearR, 0)} className="as-ring near" />
        <polygon points={cylinder} className="as-cylinder" />
        <polyline points={ring(overheadR, 0)} className="as-ring overhead" />
        <polyline points={ring(overheadR, ceiling)} className="as-ring overhead ceiling" />

        {/* Altitude ruler. */}
        {cosP > 0.15 && (
          <g className="as-ruler">
            <line x1={homeX} y1={homeY} x2={ceilX} y2={ceilY} />
            {ticks.map((f) => {
              const [tx, ty] = project(0, 0, f * FT_M * exaggeration);
              return (
                <g key={f}>
                  <line x1={tx - 4} y1={ty} x2={tx + 4} y2={ty} />
                  <text x={tx - 8} y={ty + 4} textAnchor="end">
                    {f >= 1000 ? `${f / 1000}k ft` : `${f} ft`}
                  </text>
                </g>
              );
            })}
          </g>
        )}

        {/* Selected pass's track, with its shadow on the ground. */}
        {trackPts && trackPts.length > 1 && (
          <g className="as-track">
            <polyline className="shadow" points={line(trackPts.map((t) => project(t.x, t.y, 0)))} />
            <polyline points={line(trackPts.map((t) => project(t.x, t.y, t.z)))} />
            {(() => {
              const last = trackPts[trackPts.length - 1]!;
              const [ex, ey] = project(last.x, last.y, last.z);
              return <circle cx={ex} cy={ey} r={3.5} />;
            })()}
          </g>
        )}

        {/* Passes at their closest approach. */}
        {dots.map(({ p, top, ground }) => {
          const on = p.id === selectedId;
          return (
            <g
              key={p.id}
              className={`as-pass${p.qualified ? ' qualified' : ' near'}${on ? ' on' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                if (!dragged.current) onSelect?.(on ? null : p.id);
              }}
            >
              <title>{p.label}</title>
              <line x1={ground[0]} y1={ground[1]} x2={top[0]} y2={top[1]} className="stem" />
              <circle cx={ground[0]} cy={ground[1]} r={1.8} className="foot" />
              <circle cx={top[0]} cy={top[1]} r={on ? 7 : 4.5} />
            </g>
          );
        })}

        {/* Labels. */}
        <g className="as-labels">
          <circle cx={homeX} cy={homeY} r={4} className="as-home" />
          <text x={homeX + 7} y={homeY + 14}>
            home
          </text>
          {(
            [
              [overheadR, 'overhead'],
              [nearR, 'near'],
              ...(searchR <= R * 1.02 ? ([[searchR, 'search']] as const) : []),
            ] as const
          ).map(([r, k]) => {
            const [lx, ly] = labelAt(r);
            return (
              <text key={k} x={lx + 3} y={ly - 5} className={`ring-label ${k}`}>
                {fmtMetres(r)}
              </text>
            );
          })}
          {cosP > 0.15 && (
            <text x={ceilLabelX + 6} y={ceilLabelY + 4} className="ring-label overhead">
              {geometry.max_altitude_ft.toLocaleString()} ft ceiling
            </text>
          )}
          <text x={northX} y={northY} className="as-north" textAnchor="middle">
            N
          </text>
        </g>
        {showMap && (
          <text x={W - 8} y={H - 8} textAnchor="end" className="as-credit">
            © OpenStreetMap contributors
          </text>
        )}
      </svg>
      <div className="muted small">
        Drag to orbit.{exaggeration > 1 ? ` Heights are stretched ${exaggeration}×.` : ''} Dots are
        passes at their closest approach
        {onSelect ? '; click one to draw its track' : ''}.
      </div>
    </div>
  );
}
