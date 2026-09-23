/**
 * Per-frame display settings: which recent overflights a frame shows and
 * how often that choice may change. Mirrors public.device_display_settings;
 * the bounds below match its check constraints exactly.
 */
export interface DisplayWeights {
  /** First sightings of an aircraft type or airframe. */
  rarity: number;
  /** Close and low passes. */
  proximity: number;
  /** Newer passes within the window. */
  recency: number;
  /** How specific the matching artwork is (exact airframe > livery > type). */
  artwork: number;
  /** How much we know: model, operator, route, registration. */
  detail: number;
}

export interface DisplaySettings {
  /** Planes shown at once. */
  max_planes: number;
  /** Rolling window: only passes from the last N hours are candidates. */
  window_hours: number;
  /** A new selection is committed at most this often. */
  min_dwell_minutes: number;
  include_near_misses: boolean;
  include_helicopters: boolean;
  /** Only aircraft with a known airline operator. */
  airline_only: boolean;
  /** At most one plane per operator + aircraft type in a selection. */
  one_per_operator_type: boolean;
  weights: DisplayWeights;
  /** Local hours (location time zone) during which the frame sleeps. Both or neither. */
  quiet_start_hour: number | null;
  quiet_end_hour: number | null;
}

export const DISPLAY_LIMITS = {
  max_planes: { min: 1, max: 4 },
  window_hours: { min: 1, max: 168 },
  min_dwell_minutes: { min: 0, max: 1440 },
  weight: { min: 0, max: 10 },
  hour: { min: 0, max: 23 },
} as const;

export const DEFAULT_DISPLAY_SETTINGS: DisplaySettings = {
  max_planes: 3,
  window_hours: 6,
  min_dwell_minutes: 60,
  include_near_misses: false,
  include_helicopters: true,
  airline_only: false,
  one_per_operator_type: true,
  weights: { rarity: 3, proximity: 2, recency: 1, artwork: 2, detail: 1 },
  quiet_start_hour: null,
  quiet_end_hour: null,
};

export type DisplaySettingsPatch = Partial<Omit<DisplaySettings, 'weights'>> & {
  weights?: Partial<DisplayWeights>;
};

export function mergeDisplaySettings(
  base: DisplaySettings,
  patch: DisplaySettingsPatch | undefined,
): DisplaySettings {
  if (!patch) return base;
  const { weights, ...rest } = patch;
  return { ...base, ...rest, weights: { ...base.weights, ...weights } };
}
