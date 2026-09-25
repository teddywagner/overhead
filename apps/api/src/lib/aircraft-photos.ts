import type { AircraftPhoto, PhotoCandidate } from '@overhead/flight-tracking';

export interface AircraftPhotoSource {
  photo(icao24: string, registration?: string | null): Promise<AircraftPhoto | null>;
}

export interface CandidateSources {
  planespotters: AircraftPhotoSource;
  adsbdb?: { photo(icao24: string): Promise<PhotoCandidate | null> };
  commons?: { photos(registration: string | null): Promise<PhotoCandidate[]> };
}

export interface PhotoCandidates {
  items: PhotoCandidate[];
  /** Sources that failed this time (the others still answered). */
  failed: PhotoCandidate['provider'][];
}

/** Photo lookups for the admin board, cached so paging through cards stays cheap. */
export interface AircraftPhotoLookup {
  /** The default photo for a card (Planespotters). */
  photo(icao24: string, registration: string | null): Promise<AircraftPhoto | null>;
  /** Every photo on offer from every source, for picking a favourite. */
  candidates(icao24: string, registration: string | null): Promise<PhotoCandidates>;
}

const HIT_TTL_MS = 12 * 60 * 60 * 1000;
/** Photos get added over time; look again sooner when there was none. */
const MISS_TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 5000;

/**
 * Small in-memory TTL cache. Concurrent lookups for one key share a
 * promise; failures are not cached.
 */
export class LookupCache<T> {
  private readonly entries = new Map<string, { at: number; value: Promise<T> }>();

  constructor(
    private readonly isHit: (v: T) => boolean,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit) {
      const fresh = hit.value.then(
        (v) => this.now() - hit.at < (this.isHit(v) ? HIT_TTL_MS : MISS_TTL_MS),
      );
      return fresh.then((ok) => (ok ? hit.value : this.load(key, load)));
    }
    return this.load(key, load);
  }

  private load(key: string, load: () => Promise<T>): Promise<T> {
    const value = load();
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

const toCandidate = (p: AircraftPhoto): PhotoCandidate => ({
  provider: 'planespotters',
  thumbnailUrl: p.largeUrl,
  imageUrl: p.largeUrl,
  pageUrl: p.pageUrl,
  creator: p.photographer,
  licenseName: null,
  licenseUrl: null,
});

export class CachedAircraftPhotos implements AircraftPhotoLookup {
  private readonly single: LookupCache<AircraftPhoto | null>;
  private readonly adsbdb: LookupCache<PhotoCandidate | null>;
  private readonly commons: LookupCache<PhotoCandidate[]>;

  constructor(
    private readonly sources: CandidateSources,
    now: () => number = Date.now,
  ) {
    this.single = new LookupCache((v) => v !== null, now);
    this.adsbdb = new LookupCache((v) => v !== null, now);
    this.commons = new LookupCache((v) => v.length > 0, now);
  }

  photo(icao24: string, registration: string | null): Promise<AircraftPhoto | null> {
    const key = `${icao24.toLowerCase()}|${registration?.toUpperCase() ?? ''}`;
    return this.single.get(key, () => this.sources.planespotters.photo(icao24, registration));
  }

  async candidates(icao24: string, registration: string | null): Promise<PhotoCandidates> {
    const { adsbdb, commons } = this.sources;
    const reg = registration?.toUpperCase() ?? null;
    const lookups: Array<[PhotoCandidate['provider'], Promise<PhotoCandidate[]>]> = [
      ['planespotters', this.photo(icao24, registration).then((p) => (p ? [toCandidate(p)] : []))],
    ];
    if (adsbdb) {
      lookups.push([
        'adsbdb',
        this.adsbdb
          .get(icao24.toLowerCase(), () => adsbdb.photo(icao24))
          .then((p) => (p ? [p] : [])),
      ]);
    }
    if (commons && reg) {
      lookups.push(['wikimedia_commons', this.commons.get(reg, () => commons.photos(reg))]);
    }
    const settled = await Promise.allSettled(lookups.map(([, p]) => p));
    const items: PhotoCandidate[] = [];
    const failed: PhotoCandidate['provider'][] = [];
    settled.forEach((r, i) =>
      r.status === 'fulfilled' ? items.push(...r.value) : failed.push(lookups[i]![0]),
    );
    // The same picture can come back twice (e.g. a retry); keep the first.
    const seen = new Set<string>();
    return {
      items: items.filter((c) => !seen.has(c.imageUrl) && seen.add(c.imageUrl)),
      failed,
    };
  }
}
