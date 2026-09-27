/**
 * Sighting highlights against local Supabase: the location's home country is
 * the registration country most passes carry; military, rare-type and
 * foreign aircraft are labelled in the admin report and the frame's display
 * candidates, and the report can be narrowed to them.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { HighlightKind } from '@overhead/core';
import type { Sql } from '@overhead/database';
import { loadDisplayCandidates } from '@overhead/display/sql';
import {
  ENV,
  call,
  createTestUser,
  deleteTestUser,
  makeApp,
  skipIntegration,
  sqlFor,
  type TestUser,
} from './harness';

const hex = () => `b${crypto.randomUUID().replace(/-/g, '').slice(0, 5)}`;

interface Report {
  airframes: number;
  interesting_airframes: number;
  home_country: string | null;
  items: Array<{ icao24: string; highlights: Array<{ kind: HighlightKind; label: string }> }>;
}

interface Plane {
  icao24: string;
  type: string;
  country: string | null;
  operator: string | null;
  operatorCountry: string | null;
  military?: boolean;
}

describe.skipIf(skipIntegration)('sighting highlights', () => {
  const env = ENV!;
  let sql: Sql;
  let admin: TestUser;
  let owner: TestUser;
  let app: ReturnType<typeof makeApp>['app'];
  let deps: ReturnType<typeof makeApp>['deps'];
  let locationId: string;
  const aircraftIds: string[] = [];

  const home = (): Plane => ({
    icao24: hex(),
    type: 'ZZ8',
    country: 'Testland',
    operator: 'Home Air',
    operatorCountry: 'Testland',
  });
  const planes = {
    home1: home(),
    home2: home(),
    home3: home(),
    military: { ...home(), operator: null, operatorCountry: null, military: true },
    rare: { ...home(), type: 'A388' },
    foreignOperator: {
      ...home(),
      country: 'Elsewhere',
      operator: 'Far Air',
      operatorCountry: 'Elsewhere',
    },
    foreignPrivate: { ...home(), country: 'Elsewhere', operator: null, operatorCountry: null },
  } satisfies Record<string, Plane>;

  const report = async (query = '') =>
    (await call<Report>(app, 'GET', `/admin/v1/seen-aircraft?owner_id=${owner.id}${query}`, admin))
      .body.data;

  beforeAll(async () => {
    ({ app, deps } = makeApp(env));
    sql = sqlFor(env);
    admin = await createTestUser(env, 'highlights-admin');
    owner = await createTestUser(env, 'highlights-owner');
    await sql`insert into private.admins (user_id) values (${admin.id})`;
    const [loc] = (await sql`
      insert into public.locations (owner_id, name, latitude, longitude)
      values (${owner.id}, 'Highlights test', 0.3, 0.3) returning id`) as Array<{ id: string }>;
    locationId = loc!.id;
    for (const p of Object.values(planes) as Plane[]) {
      const [a] = (await sql`
        insert into public.aircraft (icao24, icao_type_code, manufacturer, country,
                                     operator_name, operator_country, is_military)
        values (${p.icao24}, ${p.type}, ${p.type === 'A388' ? 'Airbus' : null}, ${p.country},
                ${p.operator}, ${p.operatorCountry}, ${p.military ?? false})
        returning id`) as Array<{ id: string }>;
      aircraftIds.push(a!.id);
      await sql`
        insert into public.overflights (owner_id, location_id, aircraft_id, provider,
          provider_pass_key, icao24, first_seen_at, closest_seen_at, last_seen_at, local_date,
          minimum_distance_m, closest_altitude_ft, closest_latitude, closest_longitude, status,
          qualification_reason)
        values (${owner.id}, ${locationId}, ${a!.id}, 'mock', ${`hl:${p.icao24}`}, ${p.icao24},
          now() - interval '10 minutes', now() - interval '9 minutes', now() - interval '8 minutes',
          current_date, 150, 3000, 0.301, 0.3, 'qualified', 'crossed_within_overhead_radius')`;
    }
  });

  afterAll(async () => {
    await deleteTestUser(env, admin);
    await deleteTestUser(env, owner);
    if (aircraftIds.length) await sql`delete from public.aircraft where id in ${sql(aircraftIds)}`;
    await sql.close();
    await deps.close();
  });

  const expected: Record<keyof typeof planes, HighlightKind[]> = {
    home1: [],
    home2: [],
    home3: [],
    military: ['military'],
    rare: ['rare_type'],
    foreignOperator: ['foreign_operator'],
    foreignPrivate: ['foreign_aircraft'],
  };

  test('the admin report labels interesting airframes and can show only them', async () => {
    const all = await report();
    expect(all.home_country).toBe('Testland');
    expect(all.airframes).toBe(7);
    expect(all.interesting_airframes).toBe(4);
    for (const [key, kinds] of Object.entries(expected)) {
      const item = all.items.find((i) => i.icao24 === planes[key as keyof typeof planes].icao24);
      expect({ key, kinds: item?.highlights.map((h) => h.kind) }).toEqual({ key, kinds });
    }
    const rare = all.items.find((i) => i.icao24 === planes.rare.icao24)!;
    expect(rare.highlights[0]!.label).toBe('Rare: Airbus A380');

    const only = await report('&interesting=true');
    expect(only.airframes).toBe(4);
    expect(only.items.map((i) => i.icao24).sort()).toEqual(
      [planes.military, planes.rare, planes.foreignOperator, planes.foreignPrivate]
        .map((p) => p.icao24)
        .sort(),
    );
  });

  test("a frame's display candidates carry the same highlights", async () => {
    const candidates = await loadDisplayCandidates(
      sql,
      { ownerId: owner.id, locationId },
      new Date(),
      6,
    );
    expect(candidates).toHaveLength(7);
    for (const [key, kinds] of Object.entries(expected)) {
      const c = candidates.find((x) => x.icao24 === planes[key as keyof typeof planes].icao24);
      expect({ key, kinds: c?.highlights.map((h) => h.kind) }).toEqual({ key, kinds });
    }
  });
});
