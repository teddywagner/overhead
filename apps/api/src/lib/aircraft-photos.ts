import type { AircraftPhoto } from '@overhead/flight-tracking';

export interface AircraftPhotoSource {
  photo(icao24: string, registration?: string | null): Promise<AircraftPhoto | null>;
}

/** Photo lookups for the admin board, cached so paging through cards stays cheap. */
export interface AircraftPhotoLookup {
  photo(icao24: string, registration: string | null): Promise<AircraftPhoto | null>;
}

const HIT_TTL_MS = 12 * 60 * 60 * 1000;
/** Photos get added over time; look again sooner when there was none. */
const MISS_TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 5000;

/**
 * In-memory cache in front of a photo source. Concurrent requests for the
 * same airframe share one lookup; failures are not cached.
 */
export class CachedAircraftPhotos implements AircraftPhotoLookup {
  private readonly entries = new Map<
    string,
    { at: number; value: Promise<AircraftPhoto | null> }
  >();

  constructor(
    private readonly source: AircraftPhotoSource,
    private readonly now: () => number = Date.now,
  ) {}

  photo(icao24: string, registration: string | null): Promise<AircraftPhoto | null> {
    const key = `${icao24.toLowerCase()}|${registration?.toUpperCase() ?? ''}`;
    const hit = this.entries.get(key);
    if (hit) {
      const settled = hit.value.then((v) => this.now() - hit.at < (v ? HIT_TTL_MS : MISS_TTL_MS));
      return settled.then((fresh) => (fresh ? hit.value : this.fetch(key, icao24, registration)));
    }
    return this.fetch(key, icao24, registration);
  }

  private fetch(key: string, icao24: string, registration: string | null) {
    const value = this.source.photo(icao24, registration);
    this.entries.delete(key);
    this.entries.set(key, { at: this.now(), value });
    // Maps iterate in insertion order: drop the oldest beyond the cap.
    for (const k of this.entries.keys()) {
      if (this.entries.size <= MAX_ENTRIES) break;
      this.entries.delete(k);
    }
    value.catch(() => {
      if (this.entries.get(key)?.value === value) this.entries.delete(key);
    });
    return value;
  }
}
