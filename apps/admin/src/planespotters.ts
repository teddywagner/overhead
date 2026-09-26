import { api, unwrap, type Schemas } from './api';

/**
 * Aircraft photos from Planespotters.net, looked up through the API (it
 * needs a server User-Agent with contact details). The images themselves are
 * hotlinked from Planespotters, as their terms require, with the
 * photographer credited and a link to the photo page.
 */
export type PlanePhoto = NonNullable<Schemas['AircraftPhoto']['photo']>;

const MAX_CONCURRENT = 3;
const cache = new Map<string, Promise<PlanePhoto | null>>();
let active = 0;
const waiting: Array<() => void> = [];

async function limited<T>(run: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((go) => waiting.push(go));
  active++;
  try {
    return await run();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

/** Best photo for an airframe; null when Planespotters has none. */
export function planePhoto(
  icao24: string,
  registration: string | null,
): Promise<PlanePhoto | null> {
  const key = `${icao24}|${registration ?? ''}`;
  let hit = cache.get(key);
  if (!hit) {
    hit = limited(() =>
      unwrap(
        api.GET('/admin/v1/aircraft-photos/{icao24}', {
          params: {
            path: { icao24 },
            query: registration ? { registration } : {},
          },
        }),
      ).then((d) => d.photo),
    );
    // Forget failures so a later render can retry.
    hit.catch(() => cache.delete(key));
    cache.set(key, hit);
  }
  return hit;
}

export type PhotoCandidate = Schemas['PhotoCandidate'];
export type SavedPhoto = Schemas['SavedPhoto'];
export type PhotoPickResult = Schemas['PhotoPickResult'];
export type CollectionPhoto = NonNullable<Schemas['SeenAircraft']['collection_best']>;
export type CollectionEntry = Schemas['PhotoCollectionEntry'];

/** Every photo on offer for an airframe, from all sources. */
export const photoCandidates = (icao24: string, registration: string | null) =>
  unwrap(
    api.GET('/admin/v1/aircraft-photos/{icao24}/candidates', {
      params: { path: { icao24 }, query: registration ? { registration } : {} },
    }),
  );

/**
 * Save one of the offered photos as this airframe's pick. `collection` says
 * whether it filled its operator + type slot or there is a best to compare.
 */
export const savePhoto = (icao24: string, registration: string | null, imageUrl: string) =>
  unwrap(
    api.POST('/admin/v1/aircraft-photos/{icao24}/picks', {
      params: { path: { icao24 } },
      body: { image_url: imageUrl, ...(registration ? { registration } : {}) },
    }),
  );

/** Make a saved photo the best for its operator + type slot. */
export const setCollectionBest = (sourceImageId: string) =>
  unwrap(api.PUT('/admin/v1/photo-collection', { body: { source_image_id: sourceImageId } }));

export const unsavePhoto = (id: string) =>
  unwrap(api.DELETE('/admin/v1/aircraft-photos/picks/{id}', { params: { path: { id } } }));

export const PROVIDER_LABEL: Record<string, string> = {
  planespotters: 'Planespotters.net',
  wikimedia_commons: 'Wikimedia Commons',
  adsbdb: 'airport-data.com (adsbdb)',
};
