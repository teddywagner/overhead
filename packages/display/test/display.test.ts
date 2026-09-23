import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_DISPLAY_SETTINGS,
  decideCommit,
  inQuietHours,
  mergeDisplaySettings,
  scoreComponents,
  selectForDisplay,
  sleepSecondsWithQuietHours,
  toDisplayItems,
  wakeSchedule,
  weightedScore,
  type DisplayCandidate,
  type DisplaySettings,
} from '../src';

const NOW = new Date('2026-09-23T18:00:00Z');
const RULES = { overhead_radius_m: 1200, max_altitude_ft: 15000 };
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

let seq = 0;
function candidate(over: Partial<DisplayCandidate> = {}): DisplayCandidate {
  seq++;
  return {
    overflight_id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    icao24: `a${String(seq).padStart(5, '0')}`,
    registration: `N${seq}OH`,
    callsign: `EXA${seq}`,
    flight_number: null,
    origin_code: null,
    destination_code: null,
    origin_name: null,
    destination_name: null,
    closest_seen_at: hoursAgo(1),
    status: 'qualified',
    minimum_distance_m: 400,
    closest_altitude_ft: 5000,
    icao_type_code: 'B738',
    manufacturer: 'Boeing',
    model: '737-800',
    operator_name: 'Example Air',
    operator_icao: 'EXA',
    aircraft_class: 'landplane',
    art_asset_id: null,
    art_scope: null,
    airframe_sightings: 1,
    type_sightings: 10,
    ...over,
  };
}

const settings = (over: Partial<DisplaySettings> = {}) => ({
  ...DEFAULT_DISPLAY_SETTINGS,
  ...over,
});
const ids = (xs: { candidate: DisplayCandidate }[]) => xs.map((x) => x.candidate.overflight_id);

describe('scoring', () => {
  test('a first-ever type outranks the fortieth of a common one', () => {
    const rare = candidate({ icao_type_code: 'A388', operator_icao: 'UAE', type_sightings: 1 });
    const common = candidate({ type_sightings: 40, airframe_sightings: 12 });
    const pick = selectForDisplay([common, rare], settings({ max_planes: 1 }), RULES, NOW);
    expect(ids(pick.selected)).toEqual([rare.overflight_id]);
  });

  test('components stay within 0–1 and unknown types are not treated as rare', () => {
    const c = scoreComponents(
      candidate({
        icao_type_code: null,
        type_sightings: null,
        closest_altitude_ft: null,
        minimum_distance_m: 99_999,
        closest_seen_at: hoursAgo(50),
      }),
      settings(),
      RULES,
      NOW,
    );
    for (const v of Object.values(c)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(c.rarity).toBeLessThan(0.6);
    expect(c.proximity).toBe(0);
    expect(c.recency).toBe(0);
  });

  test('artwork specificity ranks exact airframe above generic type', () => {
    const exact = scoreComponents(candidate({ art_scope: 'registration' }), settings(), RULES, NOW);
    const generic = scoreComponents(candidate({ art_scope: 'type' }), settings(), RULES, NOW);
    expect(exact.artwork).toBeGreaterThan(generic.artwork);
  });

  test('all-zero weights score zero instead of dividing by zero', () => {
    const w = { rarity: 0, proximity: 0, recency: 0, artwork: 0, detail: 0 };
    expect(weightedScore({ rarity: 1, proximity: 1, recency: 1, artwork: 1, detail: 1 }, w)).toBe(
      0,
    );
  });
});

describe('selection', () => {
  test('never shows more than max_planes', () => {
    const cs = Array.from({ length: 8 }, (_, i) =>
      candidate({ operator_icao: `OP${String.fromCharCode(65 + i)}` }),
    );
    const pick = selectForDisplay(cs, settings({ max_planes: 4 }), RULES, NOW);
    expect(pick.selected).toHaveLength(4);
    expect(pick.ranked).toHaveLength(8);
    expect(pick.ranked.filter((r) => r.excluded === 'over_limit')).toHaveLength(4);
  });

  test('filters near misses, helicopters and non-airline aircraft on request', () => {
    const near = candidate({ status: 'near_miss', operator_icao: 'AAA' });
    const heli = candidate({
      aircraft_class: 'helicopter',
      icao_type_code: 'B407',
      operator_icao: null,
    });
    const ga = candidate({ operator_icao: null, icao_type_code: 'C172' });
    const pickDefault = selectForDisplay([near, heli, ga], settings(), RULES, NOW);
    expect(pickDefault.ranked.find((r) => r.candidate === near)?.excluded).toBe('near_miss');
    expect(ids(pickDefault.selected).sort()).toEqual([heli.overflight_id, ga.overflight_id].sort());

    const strict = selectForDisplay(
      [near, heli, ga],
      settings({ include_near_misses: true, include_helicopters: false, airline_only: true }),
      RULES,
      NOW,
    );
    expect(ids(strict.selected)).toEqual([near.overflight_id]);
    expect(strict.ranked.find((r) => r.candidate === heli)?.excluded).toBe('helicopter');
    expect(strict.ranked.find((r) => r.candidate === ga)?.excluded).toBe('not_airline');
  });

  test('shows one pass per airframe and one plane per operator + type', () => {
    const a1 = candidate({ icao24: 'abc123', minimum_distance_m: 50 });
    const a2 = candidate({ icao24: 'abc123', minimum_distance_m: 900 });
    const sameOpType = candidate({ minimum_distance_m: 100 });
    const other = candidate({ operator_icao: 'SMP', icao_type_code: 'A320' });
    const pick = selectForDisplay([a1, a2, sameOpType, other], settings(), RULES, NOW);
    expect(ids(pick.selected).sort()).toEqual([a1.overflight_id, other.overflight_id].sort());
    expect(pick.ranked.find((r) => r.candidate === a2)?.excluded).toBe('same_airframe');
    expect(pick.ranked.find((r) => r.candidate === sameOpType)?.excluded).toBe(
      'same_operator_type',
    );

    const loose = selectForDisplay(
      [a1, a2, sameOpType, other],
      settings({ one_per_operator_type: false }),
      RULES,
      NOW,
    );
    expect(loose.selected).toHaveLength(3);
  });

  test('is deterministic for equal scores', () => {
    const cs = [candidate({ operator_icao: 'AAA' }), candidate({ operator_icao: 'BBB' })];
    const a = selectForDisplay(cs, settings({ max_planes: 1 }), RULES, NOW);
    const b = selectForDisplay([...cs].reverse(), settings({ max_planes: 1 }), RULES, NOW);
    expect(ids(a.selected)).toEqual(ids(b.selected));
  });

  test('display items carry labels and order but no coordinates', () => {
    const pick = selectForDisplay(
      [candidate(), candidate({ operator_icao: 'SMP' })],
      settings(),
      RULES,
      NOW,
    );
    const items = toDisplayItems(pick.selected);
    expect(items.map((i) => i.display_order)).toEqual([0, 1]);
    for (const item of items) {
      expect(Object.keys(item).some((k) => /lat|lon/.test(k))).toBe(false);
    }
  });
});

describe('commit decision', () => {
  const current = { overflight_ids: ['a', 'b'], selected_at: hoursAgo(0.5) };

  test('first selection commits; the same set in any order does not', () => {
    expect(decideCommit(null, ['a'], NOW, 60)).toEqual({ commit: true, reason: 'initial' });
    expect(decideCommit(current, ['b', 'a'], NOW, 60)).toEqual({
      commit: false,
      reason: 'unchanged',
    });
  });

  test('a change waits for the dwell time', () => {
    const held = decideCommit(current, ['a', 'c'], NOW, 60);
    expect(held).toEqual({ commit: false, reason: 'dwell', hold_until: hoursAgo(-0.5) });
    expect(decideCommit(current, ['a', 'c'], NOW, 30)).toEqual({ commit: true, reason: 'changed' });
  });

  test('an empty sky keeps what is on screen', () => {
    expect(decideCommit(current, [], NOW, 0)).toEqual({ commit: false, reason: 'no_candidates' });
    expect(decideCommit(null, [], NOW, 0).commit).toBe(false);
  });
});

describe('quiet hours', () => {
  const tz = 'America/New_York'; // 18:00Z = 14:00 EDT
  const overnight = { quiet_start_hour: 23, quiet_end_hour: 6 };

  test('wrap past midnight', () => {
    expect(inQuietHours(new Date('2026-09-24T04:00:00Z'), tz, overnight)).toBe(true); // 00:00
    expect(inQuietHours(new Date('2026-09-24T10:30:00Z'), tz, overnight)).toBe(false); // 06:30
    expect(inQuietHours(NOW, tz, { quiet_start_hour: 5, quiet_end_hour: 5 })).toBe(false);
  });

  test('a wake that lands in quiet hours moves to their end', () => {
    // 22:30 EDT + 1 h = 23:30, inside 23-06, so sleep until 06:00 (7.5 h).
    const at = new Date('2026-09-24T02:30:00Z');
    expect(sleepSecondsWithQuietHours(at, 3600, tz, overnight)).toBe(7.5 * 3600);
    expect(sleepSecondsWithQuietHours(NOW, 3600, tz, overnight)).toBe(3600);
    expect(sleepSecondsWithQuietHours(at, 3600, null, overnight)).toBe(3600);
  });

  test('schedule skips the night', () => {
    const wakes = wakeSchedule(new Date('2026-09-24T01:00:00Z'), 3600, tz, overnight, 3);
    // 21:00 EDT -> 22:00, 23:00 is quiet -> 06:00, then 07:00
    expect(wakes).toEqual([
      '2026-09-24T02:00:00.000Z',
      '2026-09-24T10:00:00.000Z',
      '2026-09-24T11:00:00.000Z',
    ]);
  });
});

test('mergeDisplaySettings merges weights shallowly', () => {
  const merged = mergeDisplaySettings(DEFAULT_DISPLAY_SETTINGS, {
    max_planes: 4,
    weights: { rarity: 9 },
  });
  expect(merged.max_planes).toBe(4);
  expect(merged.weights).toEqual({ ...DEFAULT_DISPLAY_SETTINGS.weights, rarity: 9 });
});
