/**
 * `bun run db:load-types`: download the ICAO aircraft type list from
 * tar1090-db and load it into public.aircraft_types in the database named by
 * DATABASE_URL, then fill empty manufacturer/model on existing aircraft.
 *
 * The data is fetched at run time and never committed to this repository.
 * Re-run any time to pick up updates; rows edited by hand (source 'manual')
 * are kept. Override the source with AIRCRAFT_TYPES_URL.
 */
import { databaseEnvSchema, loadEnv } from '@overhead/core';
import { createSql } from '@overhead/database';
import {
  TAR1090_AIRCRAFT_TYPES_URL,
  decodeTar1090File,
  parseTar1090AircraftTypes,
} from '@overhead/flight-tracking';
import {
  fillAircraftFromTypes,
  upsertAircraftTypes,
} from '../apps/worker/src/aircraft-types-store';

const env = loadEnv(databaseEnvSchema);
const url = process.env.AIRCRAFT_TYPES_URL || TAR1090_AIRCRAFT_TYPES_URL;
const target = new URL(env.DATABASE_URL);

console.log(`Downloading aircraft types from ${url}`);
const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
const records = parseTar1090AircraftTypes(
  decodeTar1090File(new Uint8Array(await res.arrayBuffer())),
);
if (records.length < 1000) throw new Error(`Only ${records.length} types parsed; refusing to load`);

console.log(`Loading ${records.length} types into ${target.hostname} …`);
const sql = createSql(env.DATABASE_URL, { max: 1 });
try {
  const { written, keptManual } = await upsertAircraftTypes(sql, records, 'tar1090-db');
  const filled = await fillAircraftFromTypes(sql);
  console.log(`Types written: ${written}; manual rows kept: ${keptManual}`);
  console.log(`Aircraft with manufacturer/model filled from types: ${filled}`);
} finally {
  await sql.close();
}
