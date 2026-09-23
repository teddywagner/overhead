import type { Sql } from '@overhead/database';
import type { AircraftTypeRecord } from '@overhead/flight-tracking';

type Row = Record<string, unknown>;

/**
 * Insert or refresh aircraft types. Rows edited by hand (source 'manual')
 * are never overwritten.
 */
export async function upsertAircraftTypes(
  sql: Sql,
  records: AircraftTypeRecord[],
  source: string,
): Promise<{ written: number; keptManual: number }> {
  let written = 0;
  for (let i = 0; i < records.length; i += 500) {
    const rows = records.slice(i, i + 500).map((r) => ({
      icao_type_code: r.icaoTypeCode,
      name: r.name,
      manufacturer: r.manufacturer,
      model: r.model,
      aircraft_class: r.aircraftClass,
      engine_count: r.engineCount,
      engine_type: r.engineType,
      wake_category: r.wakeCategory,
      source,
    }));
    const res = (await sql`
      insert into public.aircraft_types ${sql(rows)}
      on conflict (icao_type_code) do update set
        name = excluded.name,
        manufacturer = excluded.manufacturer,
        model = excluded.model,
        aircraft_class = excluded.aircraft_class,
        engine_count = excluded.engine_count,
        engine_type = excluded.engine_type,
        wake_category = excluded.wake_category,
        source = excluded.source
      where public.aircraft_types.source <> 'manual'
      returning icao_type_code`) as Row[];
    written += res.length;
  }
  return { written, keptManual: records.length - written };
}

/**
 * Fill empty manufacturer/model from the type table. Never overwrites a
 * value, so adsbdb's airframe-specific details and manual edits win.
 * Pass an aircraft id to limit it to one aircraft.
 */
export async function fillAircraftFromTypes(sql: Sql, aircraftId?: string): Promise<number> {
  const res = (await sql`
    update public.aircraft a set
      manufacturer = coalesce(a.manufacturer, t.manufacturer),
      model = coalesce(a.model, t.model)
    from public.aircraft_types t
    where t.icao_type_code = a.icao_type_code
      and (a.manufacturer is null or a.model is null)
      and (t.manufacturer is not null or t.model is not null)
      and (${aircraftId ?? null}::uuid is null or a.id = ${aircraftId ?? null}::uuid)
    returning a.id`) as Row[];
  return res.length;
}
