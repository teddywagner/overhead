/**
 * What makes a sighting worth pointing out: a military aircraft, a rare
 * Boeing or Airbus type, or a plane from abroad. Pure; callers supply the
 * aircraft's details and the location's home country.
 */

export const HIGHLIGHT_KINDS = [
  'military',
  'rare_type',
  'foreign_operator',
  'foreign_aircraft',
] as const;
export type HighlightKind = (typeof HIGHLIGHT_KINDS)[number];

export interface Highlight {
  kind: HighlightKind;
  /** Short human-readable reason, e.g. "Rare: Boeing 747-8". */
  label: string;
}

/**
 * Boeing and Airbus types that are uncommon sights: out of production,
 * special freighters, or built in small numbers. ICAO type designator →
 * name used when the aircraft row has no model.
 */
export const RARE_TYPES: Readonly<Record<string, string>> = {
  // Airbus
  A30B: 'Airbus A300B2/B4',
  A306: 'Airbus A300-600',
  A310: 'Airbus A310',
  A318: 'Airbus A318',
  A338: 'Airbus A330-800',
  A342: 'Airbus A340-200',
  A343: 'Airbus A340-300',
  A345: 'Airbus A340-500',
  A346: 'Airbus A340-600',
  A388: 'Airbus A380',
  A3ST: 'Airbus Beluga',
  A337: 'Airbus BelugaXL',
  // Boeing
  B703: 'Boeing 707',
  B712: 'Boeing 717',
  B721: 'Boeing 727-100',
  B722: 'Boeing 727-200',
  B731: 'Boeing 737-100',
  B732: 'Boeing 737-200',
  B733: 'Boeing 737-300',
  B734: 'Boeing 737-400',
  B735: 'Boeing 737-500',
  B37M: 'Boeing 737 MAX 7',
  B3XM: 'Boeing 737 MAX 10',
  B741: 'Boeing 747-100',
  B742: 'Boeing 747-200',
  B743: 'Boeing 747-300',
  B744: 'Boeing 747-400',
  B748: 'Boeing 747-8',
  B74D: 'Boeing 747-400D',
  B74R: 'Boeing 747SR',
  B74S: 'Boeing 747SP',
  BLCF: 'Boeing 747 Dreamlifter',
  B753: 'Boeing 757-300',
  B762: 'Boeing 767-200',
  B764: 'Boeing 767-400',
  B77L: 'Boeing 777-200LR',
  B778: 'Boeing 777-8',
  B779: 'Boeing 777-9',
};

/** The US Department of Defense's block of Mode S addresses. */
export function isMilitaryAddress(icao24: string): boolean {
  const hex = icao24.toLowerCase();
  return /^[0-9a-f]{6}$/.test(hex) && hex >= 'ae0000' && hex <= 'afffff';
}

export interface HighlightInput {
  icao24: string;
  icao_type_code: string | null;
  manufacturer: string | null;
  model: string | null;
  /** Flagged military by the ADS-B feed's aircraft database. */
  military: boolean;
  /** Country of registration. */
  country: string | null;
  operator_name: string | null;
  operator_icao: string | null;
  /** The operating airline's country. */
  operator_country: string | null;
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Why a plane is interesting, most notable first; empty for an ordinary one.
 * `homeCountry` is where the location is (country names as adsbdb spells
 * them); with none, nothing counts as foreign.
 */
export function aircraftHighlights(p: HighlightInput, homeCountry: string | null): Highlight[] {
  const out: Highlight[] = [];
  if (p.military || isMilitaryAddress(p.icao24)) out.push({ kind: 'military', label: 'Military' });

  const rare = p.icao_type_code ? RARE_TYPES[p.icao_type_code] : undefined;
  if (rare) {
    const name = p.manufacturer && p.model ? `${p.manufacturer} ${p.model}` : rare;
    out.push({ kind: 'rare_type', label: `Rare: ${name}` });
  }

  if (homeCountry) {
    const operatorAbroad = p.operator_country && !same(p.operator_country, homeCountry);
    if (operatorAbroad) {
      const who = p.operator_name ?? p.operator_icao ?? 'Operator';
      out.push({ kind: 'foreign_operator', label: `${who} (${p.operator_country})` });
    }
    // A foreign airframe flown by an airline of the same country is already
    // covered by the operator.
    if (
      p.country &&
      !same(p.country, homeCountry) &&
      !(p.operator_country && same(p.operator_country, p.country))
    ) {
      out.push({ kind: 'foreign_aircraft', label: `Registered in ${p.country}` });
    }
  }
  return out;
}
