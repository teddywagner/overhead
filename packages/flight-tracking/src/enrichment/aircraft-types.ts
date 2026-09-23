import { z } from 'zod';
import { normalizeTypeCode } from '../normalize';

/**
 * ICAO type designator reference data (e.g. B407 -> Bell 407, helicopter,
 * 1 turbine). Parsed from tar1090-db's `icao_aircraft_types2.js`, which maps
 * each code to [name, description code, wake category], for example
 *   "B407": ["BELL 407", "H1T", "L"]
 * The data is downloaded at load time, not committed to this repository.
 */
export const TAR1090_AIRCRAFT_TYPES_URL =
  'https://raw.githubusercontent.com/wiedehopf/tar1090-db/master/db/icao_aircraft_types2.js';

export type AircraftClass =
  | 'landplane'
  | 'seaplane'
  | 'amphibian'
  | 'helicopter'
  | 'gyrocopter'
  | 'tiltrotor'
  | 'balloon'
  | 'drone';

export type EngineType = 'jet' | 'turbine' | 'piston' | 'electric' | 'rocket';

export interface AircraftTypeRecord {
  icaoTypeCode: string;
  /** Source name as published, e.g. "CESSNA 172 Skyhawk". */
  name: string;
  manufacturer: string | null;
  model: string | null;
  aircraftClass: AircraftClass | null;
  engineCount: number | null;
  engineType: EngineType | null;
  wakeCategory: string | null;
}

const CLASSES: Record<string, AircraftClass> = {
  L: 'landplane',
  S: 'seaplane',
  A: 'amphibian',
  H: 'helicopter',
  G: 'gyrocopter',
  T: 'tiltrotor',
  B: 'balloon',
  D: 'drone',
};

const ENGINES: Record<string, EngineType> = {
  J: 'jet',
  T: 'turbine', // turboprop or turboshaft
  P: 'piston',
  E: 'electric',
  R: 'rocket',
};

/** Decode an ICAO description such as "H1T" (helicopter, 1 turbine). */
export function decodeTypeDescription(desc: string | null | undefined): {
  aircraftClass: AircraftClass | null;
  engineCount: number | null;
  engineType: EngineType | null;
} {
  const m = /^([A-Z])([0-9C])([A-Z-])$/.exec(desc?.trim().toUpperCase() ?? '');
  if (!m) return { aircraftClass: null, engineCount: null, engineType: null };
  return {
    aircraftClass: CLASSES[m[1]!] ?? null,
    engineCount: /\d/.test(m[2]!) ? Number(m[2]) : null,
    engineType: ENGINES[m[3]!] ?? null,
  };
}

const SHORT_KEEP_CAPS = new Set(['DE', 'LA', 'LE', 'VAN', 'VON', 'DU', 'DA', 'DI', 'AND', 'OF']);

/** "DE HAVILLAND CANADA" -> "De Havilland Canada"; keeps short acronyms like ATR, BAE. */
export function titleCaseManufacturer(words: string[]): string {
  return words
    .map((w) => {
      if (w.length <= 3 && !SHORT_KEEP_CAPS.has(w) && /^[A-Z]+$/.test(w)) return w; // ATR, BAE, IAI
      return w
        .split('-')
        .map((part) =>
          /^MC[A-Z]{2,}$/.test(part)
            ? `Mc${part[2]}${part.slice(3).toLowerCase()}` // McDonnell
            : part
                .toLowerCase()
                .replace(/(^|[/(])([a-z])/g, (_m, p: string, c: string) => p + c.toUpperCase()),
        )
        .join('-');
    })
    .join(' ');
}

const CAPS_WORD = /^[A-Z&.'()/-]+$/;

/**
 * Split a published name into manufacturer and model. The manufacturer is the
 * leading all-caps words; the model starts at the first word with a digit or
 * lower-case letter ("BOEING 737 MAX 8", "CESSNA 172 Skyhawk"). When every word
 * is capitals ("FLIGHT DESIGN CT"), the last word is the model.
 */
export function splitTypeName(name: string): { manufacturer: string | null; model: string | null } {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { manufacturer: null, model: null };
  if (words.length === 1) return { manufacturer: null, model: words[0]! };
  let i = 0;
  while (i < words.length && CAPS_WORD.test(words[i]!)) i++;
  if (i === 0) return { manufacturer: null, model: words.join(' ') };
  if (i === words.length) i = words.length - 1; // all capitals: last word is the model
  return {
    manufacturer: titleCaseManufacturer(words.slice(0, i)).slice(0, 120),
    model: words.slice(i).join(' ').slice(0, 120),
  };
}

const sourceSchema = z.record(
  z.string(),
  z
    .tuple([z.string(), z.string().nullable().optional(), z.string().nullable().optional()])
    .rest(z.unknown()),
);

/** Parse tar1090-db's `icao_aircraft_types2` JSON. Invalid entries are skipped. */
export function parseTar1090AircraftTypes(body: unknown): AircraftTypeRecord[] {
  const parsed = sourceSchema.safeParse(body);
  if (!parsed.success) throw new Error('Aircraft type data has an unexpected shape');
  const out: AircraftTypeRecord[] = [];
  for (const [rawCode, [rawName, desc, wtc]] of Object.entries(parsed.data)) {
    const icaoTypeCode = normalizeTypeCode(rawCode);
    const name = rawName.trim().replace(/\s+/g, ' ').slice(0, 160);
    if (!icaoTypeCode || !name) continue;
    out.push({
      icaoTypeCode,
      name,
      ...splitTypeName(name),
      ...decodeTypeDescription(desc),
      wakeCategory: wtc?.trim() ? wtc.trim().slice(0, 3) : null,
    });
  }
  return out;
}

/** The files are gzip-compressed JSON despite the .js name; accept either. */
export function decodeTar1090File(bytes: Uint8Array<ArrayBuffer>): unknown {
  const isGzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
  const text = new TextDecoder().decode(isGzip ? Bun.gunzipSync(bytes) : bytes);
  return JSON.parse(text);
}
